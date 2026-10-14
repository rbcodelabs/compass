/**
 * Emergency bulk revocation of outbound MCP connector grants (ADR-0018).
 *
 * The scenario this exists for: `MCP_CONNECTOR_SECRET_ENCRYPTION_KEY` (or a
 * database dump plus that key) may have leaked, so every stored third-party
 * token has to be treated as compromised. Users disconnecting one by one is not
 * an incident response.
 *
 * ## What it does, per grant
 *
 *  1. Decrypts the stored tokens (tolerantly — see below).
 *  2. Wipes Compass's copy: `REVOKED`, both ciphertexts blanked, `generation`
 *     incremented. This is the same write `disconnectGrant` makes, so an
 *     in-flight refresh loses its compare-and-swap and cannot resurrect it.
 *  3. Asks the provider to revoke the token (RFC 7009), best effort.
 *
 * The local wipe comes **before** the provider call, mirroring the single-user
 * DELETE route: a provider that is slow or down must never be the reason a leaked
 * token stays usable through Compass.
 *
 * ## Run it with the OLD key still configured
 *
 * Step 3 needs the plaintext, so decryption must work. Rotate the key *after*
 * this run, not before. If the old key is already gone, every grant is
 * "undecryptable": Compass still wipes its copy, but it cannot name the token to
 * the provider, so those grants stay valid at the provider until the OAuth client
 * is deleted there or each user revokes Compass at the provider's own
 * authorized-apps page. The result reports that count rather than hiding it.
 *
 * ## Bounded and resumable
 *
 * Work is done in chunks against a wall-clock deadline (the route runs under a
 * 60 s function ceiling). Every processed grant leaves the matched set, so the
 * remaining count is a readback of what is left, and re-POSTing simply continues.
 */
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { decrypt } from "@/lib/crypto-secrets"
import { connectorEncryptionKey } from "@/lib/mcp-connectors/config"
import { mcpConnectorsAvailable, type ConnectorRecord } from "@/lib/mcp-connectors/store"
import { revokeAtProvider } from "@/lib/mcp-connectors/tokens"

const CHUNK_SIZE = 25
/** Provider revocations in flight at once within a chunk. */
const PROVIDER_CONCURRENCY = 5
/** Stop starting new chunks after this long; leaves headroom under `maxDuration = 60`. */
export const DEFAULT_REVOKE_DEADLINE_MS = 40_000

export interface RevokeAllInput {
  /** Limit to one catalog slug (across every origin). Absent means every connector. */
  slug?: string | null
  /** Limit to one Compass user. Absent means every user. */
  userId?: string | null
  dryRun: boolean
  deadlineMs?: number
}

export interface RevokeAllConnectorSummary {
  slug: string
  origin: string
  grants: number
  /** Whether a revocation endpoint was discovered, i.e. whether the provider can be told. */
  providerRevocation: boolean
}

export interface RevokeAllResult {
  dryRun: boolean
  /** False means the migration is unapplied and there is nothing to revoke. */
  available: boolean
  encryptionKeyConfigured: boolean
  filter: { slug: string | null; userId: string | null }
  /** Grants that held tokens when the run started. */
  matched: number
  byConnector: RevokeAllConnectorSummary[]
  /** Local copies wiped (always 0 on a dry run). */
  wiped: number
  /** Provider accepted the revocation. */
  providerRevoked: number
  /** Decrypted fine, but the provider has no endpoint or did not confirm. */
  providerNotConfirmed: number
  /** Ciphertext would not open: wiped locally, provider never told. */
  undecryptable: number
  /** Grants still holding tokens after the run. */
  remaining: number
  /** True when the deadline stopped the run early; POST again to continue. */
  truncated: boolean
}

export async function revokeAllConnectorGrants(
  input: RevokeAllInput,
  prisma: AppPrismaClient = getPrisma(),
): Promise<RevokeAllResult> {
  const filter = { slug: input.slug ?? null, userId: input.userId ?? null }
  const key = tryEncryptionKey()
  const empty: RevokeAllResult = {
    dryRun: input.dryRun,
    available: true,
    encryptionKeyConfigured: key !== null,
    filter,
    matched: 0,
    byConnector: [],
    wiped: 0,
    providerRevoked: 0,
    providerNotConfirmed: 0,
    undecryptable: 0,
    remaining: 0,
    truncated: false,
  }

  if (!(await mcpConnectorsAvailable(prisma))) return { ...empty, available: false }

  const connectors = (await prisma.mcpConnector.findMany({
    where: filter.slug ? { slug: filter.slug } : {},
  })) as ConnectorRecord[]
  if (!connectors.length) return empty
  const byId = new Map(connectors.map(connector => [connector.id, connector]))

  const where = () => ({
    connectorId: { in: [...byId.keys()] },
    status: { not: "REVOKED" },
    ...(filter.userId ? { userId: filter.userId } : {}),
  })

  const summaries: RevokeAllConnectorSummary[] = []
  let matched = 0
  for (const connector of connectors) {
    const grants = await prisma.mcpConnectorGrant.count({
      where: { ...where(), connectorId: connector.id },
    })
    matched += grants
    if (grants)
      summaries.push({
        slug: connector.slug,
        origin: connector.origin,
        grants,
        providerRevocation: Boolean(connector.revocationEndpoint),
      })
  }
  const result: RevokeAllResult = { ...empty, matched, byConnector: summaries, remaining: matched }
  if (input.dryRun || !matched) return result

  const deadline = Date.now() + (input.deadlineMs ?? DEFAULT_REVOKE_DEADLINE_MS)
  const seen = new Set<string>()

  while (Date.now() < deadline) {
    const chunk = await prisma.mcpConnectorGrant.findMany({
      where: where(),
      orderBy: { id: "asc" },
      take: CHUNK_SIZE,
    })
    // A row that was selected before but is still here was not wiped (it changed
    // under us). Stop rather than spin on it; `remaining` will report it.
    const fresh = chunk.filter(row => !seen.has(row.id))
    if (!fresh.length) break
    for (const row of fresh) seen.add(row.id)

    // Decrypt before wiping — the wipe destroys the only copy of the plaintext.
    const work = fresh.map(row => ({
      row,
      connector: byId.get(row.connectorId) ?? null,
      token: openToken(row, key),
    }))

    // Local wipe first, one write for the whole chunk. `updatedAt` is explicit
    // because DSQL has no `@updatedAt` trigger.
    const wiped = await prisma.mcpConnectorGrant.updateMany({
      where: { id: { in: fresh.map(row => row.id) }, status: { not: "REVOKED" } },
      data: {
        status: "REVOKED",
        accessTokenEncrypted: "",
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        generation: { increment: 1 },
        updatedAt: new Date(),
      },
    })
    result.wiped += wiped.count

    const revocable = work.filter(
      (item): item is typeof item & { connector: ConnectorRecord; token: string } =>
        item.token !== null && item.connector !== null,
    )
    result.undecryptable += work.filter(item => item.token === null).length
    result.providerNotConfirmed += work.filter(item => item.token !== null && !item.connector).length

    for (let start = 0; start < revocable.length; start += PROVIDER_CONCURRENCY) {
      const batch = revocable.slice(start, start + PROVIDER_CONCURRENCY)
      const confirmed = await Promise.all(batch.map(item => revokeAtProvider(item.connector, item.token)))
      for (const ok of confirmed) {
        if (ok) result.providerRevoked++
        else result.providerNotConfirmed++
      }
    }
  }

  result.remaining = await prisma.mcpConnectorGrant.count({ where: where() })
  result.truncated = result.remaining > 0 && Date.now() >= deadline
  return result
}

function tryEncryptionKey(): string | null {
  try {
    return connectorEncryptionKey()
  } catch {
    return null
  }
}

/**
 * The token to name to the provider, or `null` when the ciphertext will not open.
 *
 * A refresh token is preferred because revoking it (per RFC 7009, and in
 * practice at Google) also invalidates the access tokens issued from it, whereas
 * revoking an access token leaves the refresh token alive.
 */
function openToken(
  row: { accessTokenEncrypted: string; refreshTokenEncrypted: string | null },
  key: string | null,
): string | null {
  if (!key) return null
  try {
    if (row.refreshTokenEncrypted) return decrypt(row.refreshTokenEncrypted, key)
    if (row.accessTokenEncrypted) return decrypt(row.accessTokenEncrypted, key)
    return null
  } catch {
    return null
  }
}
