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
 * `purpose` is pinned to `"USER"` rather than read from anywhere. An OAuth
 * token must never be able to take the `RESEARCH` path (which grants a public
 * interview credential its own narrow allowlist) or the `AGENT` paths.
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
    select: { id: true, userId: true, scope: true, scopeWorkspaceId: true },
  })
  if (!accessToken) return { valid: false }

  // Fire-and-forget, exactly like the ApiKey path above: `lastUsedAt` is what
  // the phase-2 "Connected apps" panel and TTL pruning key off, and no request
  // should wait on it.
  prisma.oAuthToken
    .update({ where: { id: accessToken.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return {
    valid: true,
    userId: accessToken.userId,
    purpose: "USER",
    // Always null today (decision 1 — no workspace picker), meaning "every
    // membership the user has", which is the same reach a per-user cmp_… key
    // already carries. The column exists so narrowing stays additive.
    scopeWorkspaceId: accessToken.scopeWorkspaceId,
    scopes: parseScope(accessToken.scope),
  }
}
