import { createHash } from "crypto"
import getPrisma from "@/lib/db"

// Validates an MCP Bearer token.
// 1. Falls back to MCP_API_KEY env var (service-account key).
// 2. Otherwise looks up a per-user ApiKey by prefix+hash, checking it's not revoked.
// Returns the userId if a per-user key matched (null for service key), or false if invalid.
export async function validateMcpAuth(
  request: Request
): Promise<{
  valid: true
  userId: string | null
  purpose: "SERVICE" | "USER" | "RESEARCH" | "AGENT" | "AGENT_TURN"
  agentId?: string | null
  credentialId?: string
  scopeWorkspaceId: string | null
  scopeConversationId?: string | null
  scopeClaimId?: string | null
} | { valid: false }> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return { valid: false }
  const token = authHeader.slice(7)

  // Service-account fallback
  if (process.env.MCP_API_KEY && token === process.env.MCP_API_KEY) {
    return { valid: true, userId: null, purpose: "SERVICE", scopeWorkspaceId: null }
  }

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
