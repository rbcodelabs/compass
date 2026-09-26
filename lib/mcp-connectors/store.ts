/**
 * Persistence for outbound MCP connectors (ADR-0018): the derived
 * `mcp_connectors` row per (slug, origin), the per-user grant, and the
 * short-lived authorization request that carries `state` and the PKCE verifier
 * between two serverless invocations that share no memory.
 *
 * Three things in here are correctness rather than convenience.
 *
 * **Registration is idempotent by unique-index collision, not by checking
 * first.** Two concurrent first-connects from the same preview origin both find
 * no row and both register with the provider. The loser's insert collides on
 * `idx_mcp_connectors_slug_origin`, and it then re-reads the winner's row and
 * uses that `client_id`. Its own registration is orphaned at the provider — an
 * accumulation cost ADR-0018 accepts and documents — but Compass never ends up
 * with two client identities for one origin.
 *
 * **`state` is consumed by conditional update, never read-then-write.** The
 * callback's `updateMany` on `(state, consumedAt: null, expiresAt > now)` either
 * updates one row or zero. Zero means replayed, expired, or forged, and all
 * three get the same refusal. This is the same idiom
 * `OAuthAuthorizationCode`'s consume path uses for inbound codes.
 *
 * **Token writes are compare-and-swap on `generation`.** DSQL has no advisory
 * locks, and the in-process promise map Agent Threads uses to serialise
 * refreshes is meaningless when each refresh happens in a different invocation.
 * So the loser of a refresh race writes zero rows, notices, and re-reads the
 * winner's token instead of overwriting it with one the provider has already
 * rotated away. Pattern lifted from `lib/analytics/service.ts`.
 */
import { randomBytes } from "node:crypto"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { decrypt, encrypt } from "@/lib/crypto-secrets"
import {
  AUTH_REQUEST_TTL_MS,
  McpConnectorError,
  connectorDefinition,
  connectorEncryptionKey,
  type ConnectorDefinition,
} from "@/lib/mcp-connectors/config"
import { discoverConnector, registerConnectorClient } from "@/lib/mcp-connectors/discovery"

export interface ConnectorRecord {
  id: string
  slug: string
  origin: string
  displayName: string
  serverUrl: string
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | null
  scope: string
  clientId: string
  enabled: boolean
}

export interface GrantRecord {
  id: string
  connectorId: string
  userId: string
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  scope: string
  status: string
  generation: number
}

export interface AuthRequestRecord {
  id: string
  connectorId: string
  userId: string
  codeVerifier: string
  redirectUri: string
  returnTo: string | null
}

// ── Pre-migration fallback probe ────────────────────────────────────────────

let availabilityCache: { value: boolean; checkedAt: number } | null = null
/** A positive result is permanent; a negative one is re-probed so applying the migration needs no redeploy. */
const AVAILABILITY_NEGATIVE_TTL_MS = 30_000

/**
 * Whether `062_mcp_connectors` has been applied to the active schema.
 *
 * Per the ADR-0016 precedent the code ships before its migration is applied, so
 * every read path treats "tables absent" as *no connectors configured* and the
 * agent runs with the single hardcoded Compass MCP server. Mirrors
 * `agentRunsAvailable`: Prisma reports a missing table as `P2021`, and anything
 * else is a real fault worth surfacing.
 */
export async function mcpConnectorsAvailable(prisma: AppPrismaClient = getPrisma()): Promise<boolean> {
  if (availabilityCache?.value) return true
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < AVAILABILITY_NEGATIVE_TTL_MS) return false
  try {
    await Promise.all([
      prisma.mcpConnector.findFirst({ select: { id: true } }),
      prisma.mcpConnectorGrant.findFirst({ select: { id: true } }),
      prisma.mcpConnectorAuthRequest.findFirst({ select: { id: true } }),
    ])
    availabilityCache = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (isMissingTable(error)) {
      availabilityCache = { value: false, checkedAt: Date.now() }
      return false
    }
    throw error
  }
}

/** Test seam: forget the probe result so a suite can exercise both branches. */
export function resetMcpConnectorsAvailabilityCache(): void {
  availabilityCache = null
}

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2021"
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}

// ── Connectors ──────────────────────────────────────────────────────────────

export async function findConnector(
  slug: string,
  origin: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<ConnectorRecord | null> {
  try {
    return await prisma.mcpConnector.findUnique({ where: { slug_origin: { slug, origin } } })
  } catch (error) {
    if (isMissingTable(error)) return null
    throw error
  }
}

/**
 * The connector row for this slug at this origin, discovering and registering on
 * first use.
 *
 * `origin` is the Compass deployment's own origin, taken from
 * `trustedCompassBaseUrl()` by the caller — never from a request header. It is
 * part of the key because `redirect_uri` is matched by exact string at the
 * authorization server, so a preview deployment and production are different
 * clients as far as the provider is concerned.
 */
export async function ensureConnector(
  slug: string,
  origin: string,
  redirectUri: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<ConnectorRecord> {
  const definition = connectorDefinition(slug)
  if (!definition) throw new McpConnectorError("UNKNOWN_CONNECTOR", `No connector named "${slug}".`)

  const existing = await findConnector(slug, origin, prisma)
  if (existing) return existing

  const discovered = await discoverConnector(definition)
  if (!discovered.registrationEndpoint)
    throw new McpConnectorError(
      "REGISTRATION_FAILED",
      `${definition.displayName} advertises no registration_endpoint, so Compass cannot obtain a client_id for ${origin}. A pre-registered client would need a schema change.`,
    )

  const clientId = await registerConnectorClient({
    registrationEndpoint: discovered.registrationEndpoint,
    redirectUri,
    // The origin is in the client name so a human auditing their v0 account can
    // tell a preview registration from production at a glance. Per-origin
    // registrations never expire (v0 returns a null `client_secret_expires_at`),
    // so they accumulate and being able to read them matters.
    clientName: `Compass (${origin})`,
    scope: discovered.scope,
  })

  const data = {
    slug: definition.slug,
    origin,
    displayName: definition.displayName,
    serverUrl: definition.serverUrl,
    resource: discovered.resource,
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    revocationEndpoint: discovered.revocationEndpoint,
    scope: discovered.scope,
    clientId,
  }

  try {
    return await prisma.mcpConnector.create({ data })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // Lost the race. The winner's registration is the one this origin uses from
    // now on; ours is an orphan at the provider.
    const winner = await findConnector(slug, origin, prisma)
    if (!winner)
      throw new McpConnectorError(
        "REGISTRATION_FAILED",
        `Registration for ${slug} at ${origin} collided but no row is readable.`,
      )
    return winner
  }
}

// ── Authorization requests ──────────────────────────────────────────────────

export interface CreatedAuthRequest {
  state: string
  codeVerifier: string
}

/**
 * 32 bytes of CSPRNG as 64 hex characters — exactly `VARCHAR(64)`, and the same
 * 256 bits the PKCE verifier carries. `state` is the CSRF defence for the whole
 * flow, so it is sized as a secret rather than as a correlation id.
 */
function mintState(): string {
  return randomBytes(32).toString("hex")
}

/**
 * A 43-character base64url verifier — the RFC 7636 minimum length and the
 * shortest value `lib/oauth/pkce.ts`'s `VERIFIER_PATTERN` accepts, so the same
 * validator guards both the inbound and outbound sides.
 */
function mintCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

export async function createAuthRequest(
  input: { connectorId: string; userId: string; redirectUri: string; returnTo?: string | null },
  prisma: AppPrismaClient = getPrisma(),
): Promise<CreatedAuthRequest> {
  const state = mintState()
  const codeVerifier = mintCodeVerifier()
  await prisma.mcpConnectorAuthRequest.create({
    data: {
      state,
      connectorId: input.connectorId,
      userId: input.userId,
      // Stored in plaintext deliberately. A verifier is worthless without the
      // matching authorization code, it is single-use, and it lives for minutes
      // — encrypting it would add a key dependency to the one path that must
      // keep working when the token key is being rotated.
      codeVerifier,
      // Stored rather than rebuilt at callback time: `redirect_uri` is matched by
      // exact string at the token endpoint, and anything reconstructed from
      // forwarded-host headers is attacker-influenced.
      redirectUri: input.redirectUri,
      returnTo: input.returnTo ?? null,
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    },
  })
  return { state, codeVerifier }
}

/**
 * Atomically claims an authorization request, or refuses.
 *
 * Reads after the conditional update rather than before it, so a concurrent
 * callback with the same `state` cannot both see an unconsumed row. The caller
 * **must** still compare `userId` against its own session: a `state` that
 * arrives at a different user's browser and is accepted is a login-CSRF that
 * silently attaches the attacker's third-party account to the victim's Compass
 * user.
 */
export async function consumeAuthRequest(
  state: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<AuthRequestRecord> {
  const claimed = await prisma.mcpConnectorAuthRequest.updateMany({
    where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  })
  if (!claimed.count)
    throw new McpConnectorError(
      "INVALID_AUTH_REQUEST",
      "This authorization request is unknown, expired, or already used.",
    )
  const record = await prisma.mcpConnectorAuthRequest.findUnique({ where: { state } })
  if (!record)
    throw new McpConnectorError("INVALID_AUTH_REQUEST", "Authorization request vanished after being claimed.")
  return {
    id: record.id,
    connectorId: record.connectorId,
    userId: record.userId,
    codeVerifier: record.codeVerifier,
    redirectUri: record.redirectUri,
    returnTo: record.returnTo,
  }
}

/**
 * Deletes expired authorization requests. Bounded per call so it can ride along
 * on an ordinary request without turning into an unbounded scan.
 */
export async function pruneExpiredAuthRequests(
  prisma: AppPrismaClient = getPrisma(),
): Promise<number> {
  try {
    const stale = await prisma.mcpConnectorAuthRequest.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true },
      take: 200,
    })
    if (!stale.length) return 0
    const deleted = await prisma.mcpConnectorAuthRequest.deleteMany({
      where: { id: { in: stale.map(row => row.id) } },
    })
    return deleted.count
  } catch (error) {
    if (isMissingTable(error)) return 0
    throw error
  }
}

// ── Grants ──────────────────────────────────────────────────────────────────

export interface GrantTokens {
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  scope: string
}

/**
 * Writes the result of an authorization or a re-authorization.
 *
 * Upsert on `(connectorId, userId)`: reconnecting replaces the grant in place
 * rather than adding a second one, because two live grants for one user would
 * refresh against each other and the `generation` fence only serialises writers
 * to the same row.
 */
export async function saveGrant(
  input: { connectorId: string; userId: string } & GrantTokens,
  prisma: AppPrismaClient = getPrisma(),
): Promise<GrantRecord> {
  const key = connectorEncryptionKey()
  const encrypted = {
    accessTokenEncrypted: encrypt(input.accessToken, key),
    refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken, key) : null,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    scope: input.scope,
    status: "ACTIVE",
  }
  const row = await prisma.mcpConnectorGrant.upsert({
    where: { connectorId_userId: { connectorId: input.connectorId, userId: input.userId } },
    create: { connectorId: input.connectorId, userId: input.userId, ...encrypted },
    // `generation` increments on every write so an in-flight refresh that was
    // reading the old token loses its compare-and-swap instead of clobbering
    // this fresh one. DSQL has no `@updatedAt` trigger, hence the explicit date.
    update: { ...encrypted, generation: { increment: 1 }, updatedAt: new Date() },
  })
  return decryptGrant(row, key)
}

export async function findGrant(
  connectorId: string,
  userId: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<GrantRecord | null> {
  let row
  try {
    row = await prisma.mcpConnectorGrant.findUnique({
      where: { connectorId_userId: { connectorId, userId } },
    })
  } catch (error) {
    if (isMissingTable(error)) return null
    throw error
  }
  if (!row || row.status !== "ACTIVE") return null
  return decryptGrant(row, connectorEncryptionKey())
}

/**
 * Stores rotated tokens if and only if nobody else has written since `expected`.
 *
 * Returns the winner's grant either way — on a lost race it re-reads rather than
 * throwing, because the loser's caller wants *a* usable token, and the row now
 * holds one that is at least as fresh as the one it was about to write. A
 * provider that rotates refresh tokens (v0 does) makes the loser's own new
 * refresh token already dead, so overwriting would be strictly worse than
 * yielding.
 */
export async function rotateGrantTokens(
  input: { grantId: string; expectedGeneration: number } & GrantTokens,
  prisma: AppPrismaClient = getPrisma(),
): Promise<GrantRecord> {
  const key = connectorEncryptionKey()
  const updated = await prisma.mcpConnectorGrant.updateMany({
    where: { id: input.grantId, generation: input.expectedGeneration, status: "ACTIVE" },
    data: {
      accessTokenEncrypted: encrypt(input.accessToken, key),
      refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken, key) : null,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scope: input.scope,
      generation: { increment: 1 },
      updatedAt: new Date(),
    },
  })
  const row = await prisma.mcpConnectorGrant.findUnique({ where: { id: input.grantId } })
  if (!row || row.status !== "ACTIVE")
    throw new McpConnectorError("GRANT_CHANGED", "This connector was disconnected while a refresh was in flight.")
  if (!updated.count && row.generation === input.expectedGeneration)
    // Neither our write nor anyone else's landed: the row is ACTIVE at the
    // generation we fenced on, so the update matched nothing for a reason we
    // cannot explain. Failing is correct; retrying would spin.
    throw new McpConnectorError("GRANT_CHANGED", "Refreshed tokens could not be stored.")
  return decryptGrant(row, key)
}

/**
 * Marks a grant disconnected and drops both ciphertexts.
 *
 * `generation` still increments, so any refresh that was in flight against the
 * old generation loses its compare-and-swap and reports `GRANT_CHANGED` rather
 * than resurrecting a grant the user just revoked.
 */
export async function disconnectGrant(
  connectorId: string,
  userId: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<boolean> {
  const result = await prisma.mcpConnectorGrant.updateMany({
    where: { connectorId, userId, status: "ACTIVE" },
    data: {
      status: "REVOKED",
      accessTokenEncrypted: "",
      refreshTokenEncrypted: null,
      accessTokenExpiresAt: null,
      generation: { increment: 1 },
      updatedAt: new Date(),
    },
  })
  return result.count > 0
}

/** Which of the catalog's connectors this user currently has a live grant for. */
export async function listConnectedSlugs(
  userId: string,
  origin: string,
  prisma: AppPrismaClient = getPrisma(),
): Promise<string[]> {
  try {
    const grants = await prisma.mcpConnectorGrant.findMany({
      where: { userId, status: "ACTIVE" },
      select: { connectorId: true },
      take: 100,
    })
    if (!grants.length) return []
    const connectors = await prisma.mcpConnector.findMany({
      where: { id: { in: grants.map(grant => grant.connectorId) }, origin, enabled: true },
      select: { slug: true },
    })
    return connectors.map(connector => connector.slug).sort()
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
}

interface GrantRow {
  id: string
  connectorId: string
  userId: string
  accessTokenEncrypted: string
  refreshTokenEncrypted: string | null
  accessTokenExpiresAt: Date | null
  scope: string
  status: string
  generation: number
}

/**
 * Decryption is **not** made tolerant of failure.
 *
 * A ciphertext that will not open means the key changed (or the row was
 * tampered with), and the honest outcome is a loud error that leads to
 * reconnecting. Swallowing it into `null` would present a revoked-looking
 * connector and send someone hunting through the provider's dashboard for a
 * grant that is still perfectly valid.
 */
function decryptGrant(row: GrantRow, key: string): GrantRecord {
  return {
    id: row.id,
    connectorId: row.connectorId,
    userId: row.userId,
    accessToken: decrypt(row.accessTokenEncrypted, key),
    refreshToken: row.refreshTokenEncrypted ? decrypt(row.refreshTokenEncrypted, key) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scope: row.scope,
    status: row.status,
    generation: row.generation,
  }
}

export type { ConnectorDefinition }
