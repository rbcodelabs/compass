/**
 * Ephemeral per-user MCP API keys for agent turns.
 *
 * The in-app agent runs inside a sandbox and calls back into Compass's own
 * /api/mcp AS the acting user, so the Phase 1 per-user authorization (every
 * tool membership/role-scoped) applies to what the agent can see and do. To do
 * that the sandbox needs a per-user `cmp_…` key — NOT the shared service key
 * (which is global/unscoped). We mint one scoped to the acting user for the
 * duration of a turn and revoke it immediately after.
 *
 * The token format matches validateMcpAuth (lib/mcp-auth.ts):
 *   token     = "cmp_" + 32 hex chars   (length 36)
 *   keyPrefix = first 8 of the 32 hex   (indexed lookup)
 *   keyHash   = sha256(token)           (stored; the raw token is never stored)
 */

import { randomBytes, createHash } from "node:crypto"
import getPrisma from "@/lib/db"

export type MintedAgentKey = { token: string; apiKeyId: string }

async function mintScopedMcpKey({
  userId,
  name,
  purpose,
  scopeWorkspaceId,
  expiresAt,
  scopeConversationId,
  scopeClaimId,
}: {
  userId: string
  name: string
  purpose?: "RESEARCH" | "AGENT_TURN"
  scopeWorkspaceId?: string
  expiresAt?: Date
  scopeConversationId?: string
  scopeClaimId?: string
}): Promise<MintedAgentKey> {
  const randomPart = randomBytes(16).toString("hex")
  const token = `cmp_${randomPart}`
  const keyPrefix = randomPart.slice(0, 8)
  const keyHash = createHash("sha256").update(token).digest("hex")

  const prisma = getPrisma()
  const row = await prisma.apiKey.create({
    data: { userId, name, keyHash, keyPrefix, purpose, scopeWorkspaceId, expiresAt, scopeConversationId, scopeClaimId },
    select: { id: true },
  })
  return { token, apiKeyId: row.id }
}

/** Mint an ephemeral per-user MCP key. Returns the raw token (only chance to
 *  read it) and the row id for later revocation. */
export async function mintAgentMcpKey(userId: string, workspaceId: string, scope?: { scopeConversationId: string; scopeClaimId: string }): Promise<MintedAgentKey> {
  return mintScopedMcpKey({ userId, name: "agent-turn (ephemeral)", purpose: "AGENT_TURN", scopeWorkspaceId: workspaceId, expiresAt: new Date(Date.now() + 5 * 60 * 1000), ...scope })
}

/** Mint a read-only research-agent key locked to exactly one workspace. */
export async function mintResearchAgentMcpKey(
  userId: string,
  workspaceId: string,
): Promise<MintedAgentKey> {
  return mintScopedMcpKey({
    userId,
    name: "research-interview (ephemeral)",
    purpose: "RESEARCH",
    scopeWorkspaceId: workspaceId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  })
}

/** Revoke a minted key. Safe to call in a finally block; never throws. */
export async function revokeAgentMcpKey(apiKeyId: string): Promise<void> {
  try {
    const prisma = getPrisma()
    await prisma.apiKey.update({ where: { id: apiKeyId }, data: { revokedAt: new Date() } })
  } catch {
    // Best effort: every newly minted turn key also expires after five minutes.
  }
}

/**
 * Run `fn` with a freshly-minted per-user MCP token, revoking it afterward
 * regardless of outcome. The token is only ever passed to the sandbox as an
 * env var at runCommand time (never persisted, never logged).
 */
export async function withAgentMcpKey<T>(
  userId: string,
  workspaceId: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const { token, apiKeyId } = await mintAgentMcpKey(userId, workspaceId)
  try {
    return await fn(token)
  } finally {
    await revokeAgentMcpKey(apiKeyId)
  }
}
