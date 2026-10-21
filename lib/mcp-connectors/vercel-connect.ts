/**
 * Token source for connectors whose credentials live in Vercel Connect
 * (`ConnectorDefinition.tokenSource.kind === "vercel-connect"`).
 *
 * Vercel Connect owns the OAuth client id/secret, the consent screen, token
 * storage and refresh. Compass only ever holds a short-lived access token, in
 * memory, for the duration of a request. This module is the one place that
 * talks to `@vercel/connect` for connectors, so the rest of the feature keeps
 * speaking `McpConnectorError`.
 *
 * ## The subject is always the Compass session's user
 *
 * Every function takes a `userId` that the caller took from `auth()` or from a
 * server-minted `AGENT_TURN` credential. It is never read from request input:
 * Connect keys the stored grant by this subject, so a caller-controlled value
 * would let one user spend another's Drive grant.
 *
 * ## Access levels
 *
 * Connect stores one grant per connector and subject and exposes no scope
 * readback, so the level is found by asking for a token at each level's scope,
 * widest first (the catalog order). The last level that worked is remembered
 * in-process for a few minutes and tried first, so a steady state costs one
 * token request rather than one per level. The SDK also caches tokens, which
 * matters because Connect bills per token request.
 */
import {
  ConnectError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  getToken,
  revokeToken,
  startAuthorization,
} from "@vercel/connect"
import type { AppPrismaClient } from "@/lib/db"
import {
  McpConnectorError,
  usesVercelConnect,
  vercelConnectUid,
  CONNECTOR_DEFINITIONS,
  type ConnectorDefinition,
} from "@/lib/mcp-connectors/config"
import { listConnectedGrants } from "@/lib/mcp-connectors/store"

export interface ConnectAccess {
  accessToken: string
  /** The scope string of the level the token was minted for. */
  scope: string
  levelId: string | null
}

interface Level {
  id: string | null
  scope: string
}

const LEVEL_MEMO_TTL_MS = 5 * 60 * 1000
const levelMemo = new Map<string, { levelId: string | null; expiresAt: number }>()

/** Test hook; the memo is a process-local optimisation with no correctness role. */
export function resetConnectLevelMemo(): void {
  levelMemo.clear()
}

function levelsOf(definition: ConnectorDefinition): Level[] {
  const levels = definition.accessLevels?.map(level => ({ id: level.id, scope: level.scope }))
  return levels?.length ? levels : [{ id: null, scope: definition.fallbackScope }]
}

function requireUid(definition: ConnectorDefinition): string {
  const uid = vercelConnectUid(definition)
  if (!uid) {
    const envName = definition.tokenSource?.kind === "vercel-connect" ? definition.tokenSource.uidEnv : "the connector UID env var"
    throw new McpConnectorError(
      "CLIENT_NOT_CONFIGURED",
      `${definition.displayName} is not configured on this deployment: set ${envName}.`,
    )
  }
  return uid
}

function requireConnectDefinition(definition: ConnectorDefinition): void {
  if (!usesVercelConnect(definition))
    throw new McpConnectorError("UNKNOWN_CONNECTOR", `${definition.displayName} is not backed by Vercel Connect.`)
}

/** Connect says the user has no usable grant: an ordinary state, rendered as a Connect button. */
function isNotConsented(error: unknown): boolean {
  return error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError
}

const LINK_PROBLEM = /not[\s_-]*linked|not[\s_-]*enabled|client_not|environment/i

/**
 * Maps a Connect failure that is *not* "user has not consented" onto the error
 * type the rest of the feature handles. Project/environment link problems are
 * an operator fix, so they get their own code and a message naming the cause.
 */
function toConnectorError(error: unknown, definition: ConnectorDefinition): McpConnectorError {
  if (error instanceof McpConnectorError) return error
  if (error instanceof ConnectError) {
    const text = `${error.code ?? ""} ${error.message}`
    if (error.status === 403 || LINK_PROBLEM.test(text))
      return new McpConnectorError(
        "CONNECT_MISCONFIGURED",
        `${definition.displayName} is not available: Vercel Connect refused the request (${error.code ?? error.status ?? "error"}). ` +
          `Check that the connector is linked to this project and enabled for this environment.`,
      )
    return new McpConnectorError("GATEWAY_FAILED", `Vercel Connect request failed: ${error.message}`.slice(0, 300))
  }
  return new McpConnectorError(
    "GATEWAY_FAILED",
    `Vercel Connect request failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
  )
}

/**
 * A usable access token for this user, or `null` when they have not connected.
 *
 * `forceRefresh` bypasses the SDK's token cache so Connect refreshes upstream;
 * it is how a provider 401 is retried.
 */
export async function getConnectAccess(
  definition: ConnectorDefinition,
  userId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ConnectAccess | null> {
  requireConnectDefinition(definition)
  const uid = requireUid(definition)
  const memoKey = `${definition.slug}:${userId}`
  const memo = levelMemo.get(memoKey)
  const levels = levelsOf(definition)
  const remembered = memo && memo.expiresAt > Date.now() ? levels.find(level => level.id === memo.levelId) : undefined
  const ordered = remembered ? [remembered, ...levels.filter(level => level !== remembered)] : levels

  for (const level of ordered) {
    try {
      const accessToken = await getToken(
        uid,
        { subject: { type: "user", id: userId }, scopes: level.scope.split(/\s+/).filter(Boolean) },
        options.forceRefresh ? { forceRefresh: true } : undefined,
      )
      levelMemo.set(memoKey, { levelId: level.id, expiresAt: Date.now() + LEVEL_MEMO_TTL_MS })
      return { accessToken, scope: level.scope, levelId: level.id }
    } catch (error) {
      if (isNotConsented(error)) continue
      throw toConnectorError(error, definition)
    }
  }
  levelMemo.delete(memoKey)
  return null
}

/**
 * The consent URL to send the user's browser to. `returnUrl` must be an
 * absolute URL on a Compass origin; Connect redirects the browser back to it.
 *
 * `prompt=consent` is passed so Google re-issues a refresh token; without one
 * the connection would die after the first hour. Whether Connect also sets
 * `access_type=offline` for this connector type is verified on a preview.
 */
export async function startConnectConsent(
  definition: ConnectorDefinition,
  userId: string,
  levelScope: string,
  returnUrl: string,
): Promise<string> {
  requireConnectDefinition(definition)
  const uid = requireUid(definition)
  try {
    const response = await startAuthorization(
      uid,
      { subject: { type: "user", id: userId }, scopes: levelScope.split(/\s+/).filter(Boolean) },
      { callbackUrl: returnUrl, prompt: "consent" },
    )
    return response.url
  } catch (error) {
    throw toConnectorError(error, definition)
  }
}

/** Removes the user's grant at Connect. Resolves `true` when something was revoked. */
export async function revokeConnectGrant(definition: ConnectorDefinition, userId: string): Promise<boolean> {
  requireConnectDefinition(definition)
  const uid = requireUid(definition)
  levelMemo.delete(`${definition.slug}:${userId}`)
  try {
    await revokeToken(uid, { subject: { type: "user", id: userId } })
    return true
  } catch (error) {
    if (isNotConsented(error)) return false
    throw toConnectorError(error, definition)
  }
}

/**
 * Every connector this user is connected to, with the scope held: stored grants
 * for DCR connectors plus a token probe for each configured Connect-backed one.
 * Sorted by slug.
 *
 * Connect-backed slugs are excluded from the stored-grant list on purpose:
 * `mcp_connector_grants` rows written before the move are unused and must not
 * make a user look connected. A Connect probe that fails for an operator
 * reason (unlinked project) reads as not connected here and surfaces its real
 * message at the point of use.
 */
export async function listConnections(
  userId: string,
  origin: string,
  prisma?: AppPrismaClient,
  /** False skips the stored-grant read (the connector tables are unmigrated). */
  storedGrantsAvailable = true,
): Promise<Array<{ slug: string; scope: string }>> {
  const connectSlugs = new Set(CONNECTOR_DEFINITIONS.filter(usesVercelConnect).map(definition => definition.slug))
  const stored = (storedGrantsAvailable ? await listConnectedGrants(userId, origin, prisma) : []).filter(grant => !connectSlugs.has(grant.slug))
  const probed = await Promise.all(
    CONNECTOR_DEFINITIONS.filter(definition => usesVercelConnect(definition) && vercelConnectUid(definition)).map(
      async definition => {
        try {
          const access = await getConnectAccess(definition, userId)
          return access ? { slug: definition.slug, scope: access.scope } : null
        } catch (error) {
          console.error("[mcp-connectors] Vercel Connect probe failed", definition.slug, error instanceof McpConnectorError ? error.code : error)
          return null
        }
      },
    ),
  )
  return [...stored, ...probed.filter((entry): entry is { slug: string; scope: string } => entry !== null)].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  )
}
