import { createHash } from "crypto"
import getPrisma from "@/lib/db"
import { mcpResourceUri, parseScope } from "@/lib/oauth/constants"
import { ACCESS_TOKEN_PREFIX, hashOAuthToken } from "@/lib/oauth/tokens"

export type McpAuthResult = {
  valid: true
  userId: string | null
  purpose: "SERVICE" | "USER" | "RESEARCH" | "AGENT" | "AGENT_TURN"
  agentId?: string | null
  credentialId?: string
  /**
   * Which table `credentialId` points into. `AgentToolCall.credential_id` is a
   * bare uuid that holds an `ApiKey.id` on the key path and an `OAuthToken.id`
   * on the agent-bound OAuth path, so without this the audit trail is silently
   * polymorphic (ADR 0015). Absent for actors that write no audit rows.
   */
  credentialType?: "API_KEY" | "OAUTH"
  scopeWorkspaceId: string | null
  scopeConversationId?: string | null
  scopeClaimId?: string | null
  /**
   * Present **only** for an OAuth access token, and the signal the route uses
   * to decide whether to enforce scopes at all. A static `cmp_…` key carries no
   * scopes and keeps its existing unrestricted reach — this feature is purely
   * additive (docs/decisions/0014-compass-is-its-own-oauth-authorization-server.md).
   */
  scopes?: string[]
} | { valid: false }

// Validates an MCP Bearer token.
// 1. Falls back to MCP_API_KEY env var (service-account key).
// 2. An OAuth access token (cmp_oat_…) resolves to the user it was issued for.
// 3. Otherwise looks up a per-user ApiKey by prefix+hash, checking it's not revoked.
// Returns the userId if a per-user key matched (null for service key), or false if invalid.
export async function validateMcpAuth(request: Request): Promise<McpAuthResult> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return { valid: false }
  const token = authHeader.slice(7)

  // Service-account fallback
  if (process.env.MCP_API_KEY && token === process.env.MCP_API_KEY) {
    return { valid: true, userId: null, purpose: "SERVICE", scopeWorkspaceId: null }
  }

  if (token.startsWith(ACCESS_TOKEN_PREFIX)) return validateOAuthAccessToken(token)

  // Per-user key: format is cmp_<32 hex chars>
  if (!token.startsWith("cmp_") || token.length !== 36) return { valid: false }
  const randomPart = token.slice(4) // 32 hex chars
  const keyPrefix = randomPart.slice(0, 8)
  const keyHash = createHash("sha256").update(token).digest("hex")

  const prisma = getPrisma()
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      keyPrefix,
      keyHash,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, userId: true, purpose: true, agentId: true, scopeWorkspaceId: true, scopeConversationId: true, scopeClaimId: true, expiresAt: true },
  })

  if (!apiKey) return { valid: false }
  if (apiKey.agentId && apiKey.purpose !== "AGENT") return { valid: false }
  if (apiKey.purpose === "AGENT") {
    if (process.env.COMPASS_AGENTS_ENABLED !== "1" || !apiKey.agentId) return { valid: false }
    const agent = await prisma.agent.findFirst({ where: { id: apiKey.agentId, ownerUserId: apiKey.userId, status: "ACTIVE" }, select: { id: true } })
    if (!agent) return { valid: false }
  }
  if (apiKey.purpose === "AGENT_TURN" && (!apiKey.scopeWorkspaceId || !apiKey.expiresAt || apiKey.expiresAt.getTime() <= Date.now())) return { valid: false }
  if (apiKey.purpose && !["USER", "RESEARCH", "AGENT", "AGENT_TURN"].includes(apiKey.purpose)) return { valid: false }
  if (
    apiKey.purpose === "RESEARCH" &&
    (!apiKey.expiresAt || apiKey.expiresAt.getTime() <= Date.now())
  ) return { valid: false }

  // Update lastUsedAt asynchronously (don't await — don't block the request)
  prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {})

  return {
    valid: true,
    userId: apiKey.userId,
    purpose: (apiKey.purpose || "USER") as "USER" | "RESEARCH" | "AGENT" | "AGENT_TURN",
    agentId: apiKey.agentId,
    credentialId: apiKey.id,
    credentialType: "API_KEY",
    scopeWorkspaceId: apiKey.scopeWorkspaceId,
    scopeConversationId: apiKey.scopeConversationId,
    scopeClaimId: apiKey.scopeClaimId,
  }
}

/**
 * The OAuth branch, and the crux of the whole authorization design: an access
 * token is just another way to name an `McpActor`. Everything downstream —
 * lib/mcp-authz.ts, every per-tool gate, the "not found or access denied"
 * non-disclosure phrasing — is untouched.
 *
 * Four predicates, each carrying a requirement:
 *
 *  - `resource: mcpResourceUri()` is where the spec's hardest MUST lands —
 *    *"MCP servers MUST only accept tokens specifically intended for themselves
 *    and MUST reject tokens that do not include them in the audience claim."*
 *    A token minted for another audience never matches, so it can never act.
 *  - `type: "ACCESS"` keeps a refresh token — which is longer-lived and is
 *    presented to `/api/oauth/token`, not here — from working as a bearer.
 *  - `revokedAt: null` because revocation is **soft**: the row survives, so a
 *    revoked token that was only checked for existence would still authenticate.
 *  - `expiresAt: { gt: … }` for the ordinary one-hour lifetime.
 *
 * `purpose` is decided by a **closed two-value parser** on the stored
 * `authorizationMode`, never a pass-through of a stored purpose string (ADR
 * 0015). Only exact `"AGENT"` and `"USER"` values are accepted; null or an
 * unrecognised value invalidates the token rather than widening it. An OAuth token
 * still cannot reach `RESEARCH` (a public interview credential's narrow
 * allowlist) or `AGENT_TURN` (server-minted, 5-minute, conversation-scoped);
 * binding a 1-hour token with a 30-day refresh to a turn-scoped purpose is
 * incoherent rather than merely unimplemented.
 */
async function validateOAuthAccessToken(token: string): Promise<McpAuthResult> {
  let resource: string
  try {
    resource = mcpResourceUri()
  } catch {
    // The deployment cannot name its own canonical audience, so it cannot
    // verify one. Refusing is the only safe answer: the alternative is
    // accepting a token whose audience was never checked.
    return { valid: false }
  }

  const prisma = getPrisma()
  const accessToken = await prisma.oAuthToken.findFirst({
    where: {
      tokenHash: hashOAuthToken(token),
      type: "ACCESS",
      revokedAt: null,
      expiresAt: { gt: new Date() },
      resource,
    },
    select: { id: true, userId: true, scope: true, scopeWorkspaceId: true, authorizationMode: true, agentId: true },
  })
  if (!accessToken) return { valid: false }
  if (accessToken.authorizationMode !== "AGENT" && accessToken.authorizationMode !== "USER") {
    return { valid: false }
  }

  // Fire-and-forget, exactly like the ApiKey path above: `lastUsedAt` is what
  // the phase-2 "Connected apps" panel and TTL pruning key off, and no request
  // should wait on it.
  prisma.oAuthToken
    .update({ where: { id: accessToken.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  if (accessToken.authorizationMode === "AGENT") {
    // Mirrors the ApiKey AGENT branch above, predicate for predicate. Three
    // properties here are load-bearing:
    //
    //  1. Agent liveness is re-checked on **every request**, not trusted from
    //     issuance, so suspending an agent stops its OAuth connection at the
    //     next call exactly as it stops its key. Yes, this is a second read on
    //     the hot path; the key path already pays it and there is no FK to join
    //     across (relationMode = "prisma"), so two reads it is.
    //  2. Every failure is `{ valid: false }` — **never** a downgrade to USER.
    //     Downgrading would make flipping COMPASS_AGENTS_ENABLED off into a
    //     privilege *escalation*, and would let a suspended agent keep working
    //     through OAuth while failing through its own key. A 401 sends the
    //     client back through discovery and consent, which is the correct and
    //     recoverable outcome.
    //  3. `credentialId` is mandatory, not decorative. withAgentActivity
    //     (lib/agent-activity.ts:7) throws "Incomplete agent identity." without
    //     it, so omitting it yields a connection where every read succeeds and
    //     every write fails — a half-working credential that reads as a Compass
    //     bug rather than a missing field.
    if (process.env.COMPASS_AGENTS_ENABLED !== "1" || !accessToken.agentId) return { valid: false }
    const agent = await prisma.agent.findFirst({
      where: { id: accessToken.agentId, ownerUserId: accessToken.userId, status: "ACTIVE" },
      select: { id: true },
    })
    if (!agent) return { valid: false }
    return {
      valid: true,
      userId: accessToken.userId,
      purpose: "AGENT",
      agentId: accessToken.agentId,
      credentialId: accessToken.id,
      credentialType: "OAUTH",
      // Pinned null rather than read from the row, so exactly one mechanism
      // narrows workspaces on this path and it is AgentWorkspaceGrant. See the
      // scopeWorkspaceId comment in prisma/schema.prisma for why the column is
      // superseded rather than built on.
      scopeWorkspaceId: null,
      scopes: parseScope(accessToken.scope),
    }
  }

  return {
    valid: true,
    userId: accessToken.userId,
    purpose: "USER",
    // Null on every USER-mode token, meaning "every membership the user has".
    // Reaching this branch means the admin override was explicitly elected;
    // legacy null and unrecognised modes were refused above.
    scopeWorkspaceId: accessToken.scopeWorkspaceId,
    scopes: parseScope(accessToken.scope),
  }
}
