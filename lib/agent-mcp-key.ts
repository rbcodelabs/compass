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
 * A run of a named cloud agent (ADR "Cloud agents as first-class identities") mints the same key with
 * `agentId` set. That key IS the agent only while a live AgentRun names it (lib/agent-run-identity.ts), and its
 * reach is the agent's AgentWorkspaceGrant set, not the invoker's memberships (lib/agent-access.ts).
 *
 * The token format matches validateMcpAuth (lib/mcp-auth.ts):
 *   token     = "cmp_" + 32 hex chars   (length 36)
 *   keyPrefix = first 8 of the 32 hex   (indexed lookup)
 *   keyHash   = sha256(token)           (stored; the raw token is never stored)
 */

import { randomBytes, createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { agentIdentityValidForTurn, agentKind, agentOwner, findAgentById } from "@/lib/agent-ownership"
import { agentsEnabled, liveGrantedWorkspaceIds } from "@/lib/agent-access"

export type MintedAgentKey = { token: string; apiKeyId: string }

async function mintScopedMcpKey({
  userId,
  name,
  purpose,
  scopeWorkspaceId,
  expiresAt,
  scopeConversationId,
  scopeClaimId,
  agentId,
}: {
  userId: string
  name: string
  agentId?: string
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
    data: { userId, name, keyHash, keyPrefix, purpose, scopeWorkspaceId, expiresAt, scopeConversationId, scopeClaimId, ...(agentId ? { agentId } : {}) },
    select: { id: true },
  })
  return { token, apiKeyId: row.id }
}

/** Default key lifetime: the old four-minute turn ceiling plus a minute of grace. */
export const DEFAULT_AGENT_KEY_TTL_MS = 5 * 60 * 1000

/** Mint an ephemeral per-user MCP key. Returns the raw token (only chance to
 *  read it) and the row id for later revocation.
 *
 *  `expiresAt` is a parameter because a detached run can outlive five
 *  minutes and its agent would otherwise lose tool access mid-turn. Callers pass
 *  `deadlineAt + 60s` grace and never longer, and record `apiKeyId` on the run so
 *  both the result path and the sweeper can revoke it — a key surviving its run
 *  requires both of those to fail. This is a real weakening of the blast radius,
 *  bounded by scoping that is otherwise unchanged. */
export async function mintAgentMcpKey(
  userId: string,
  workspaceId: string,
  scope?: { scopeConversationId: string; scopeClaimId: string },
  expiresAt?: Date,
  options: { agentId?: string | null } = {},
): Promise<MintedAgentKey> {
  if (options.agentId) await assertAgentKeyMintable(options.agentId, userId, workspaceId)
  return mintScopedMcpKey({ userId, name: "agent-turn (ephemeral)", purpose: "AGENT_TURN", scopeWorkspaceId: workspaceId, expiresAt: expiresAt ?? new Date(Date.now() + DEFAULT_AGENT_KEY_TTL_MS), agentId: options.agentId ?? undefined, ...scope })
}

export class AgentKeyMintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentKeyMintError"
  }
}

/**
 * Defense in depth for an agent-scoped key (ADR 0015's agent-scoped tokens, applied to a run): refuse to mint
 * unless the agent is an ACTIVE CLOUD agent that is already usable by `userId` in `workspaceId`.
 *
 * The key's reach is later computed from the agent's AgentWorkspaceGrant set on every request
 * (lib/agent-access.ts), so minting carries no grant list of its own: revoking a grant narrows a key already
 * in the sandbox at the next call. This check only refuses to hand out a key that could not reach the
 * workspace it is scoped to, and a USER-owned agent to anyone but its owner.
 */
async function assertAgentKeyMintable(agentId: string, userId: string, workspaceId: string) {
  if (!agentsEnabled()) throw new AgentKeyMintError("Agents are not enabled.")
  const agent = await findAgentById(getPrisma(), agentId)
  // runId is a placeholder: liveness of the run is proven per request by validateMcpAuth, not at mint time.
  if (!agent || agentKind(agent) !== "CLOUD" || !agentIdentityValidForTurn(agent, { agentId, invokerUserId: userId, runId: "mint" })) {
    throw new AgentKeyMintError("Agent is not available to run.")
  }
  const owner = agentOwner(agent)
  if (owner?.type === "WORKSPACE" && owner.workspaceId !== workspaceId) throw new AgentKeyMintError("Agent is not available in this workspace.")
  if (!(await liveGrantedWorkspaceIds(agent, "READ")).includes(workspaceId)) throw new AgentKeyMintError("Agent has no access to this workspace.")
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
