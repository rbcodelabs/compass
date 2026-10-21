/**
 * Running as an agent (ADR "Cloud agents as first-class identities", phase 2).
 *
 * Two jobs, both security-relevant and kept in one small module so they can be read at once:
 *
 *  1. {@link resolveRunAgent}: at run creation, turn the (optional) agent the caller asked for into an
 *     agent the caller is actually allowed to run, or refuse.
 *  2. {@link authorizeAgentTurnKey}: on every MCP request carrying an agent-scoped AGENT_TURN key, prove the
 *     key is still tied to a LIVE run of that exact agent before it is accepted as the agent.
 *
 * A key alone is never enough: the run row is the second factor. Revoking the key, reaching the run's
 * deadline, or the run turning terminal (finished, failed, canceled, swept) each end the agent's access at
 * the next request, and the key expires shortly after the deadline regardless.
 */

import type { AppPrismaClient } from "@/lib/db"
import { agentIdentityValidForActor, agentsEnabled, liveGrantedWorkspaceIds } from "@/lib/agent-access"
import { agentKind, canInvokeAgent, findAgentById, type AgentRecord } from "@/lib/agent-ownership"

/**
 * Statuses in which a run is still allowed to act. Mirrors NON_TERMINAL_AGENT_RUN_STATUSES in
 * lib/agent-runs.ts, which is not imported here because that module pulls in the sandbox and the
 * MCP-key minter, and mcp-auth must stay light. A test pins the two together.
 */
export const LIVE_AGENT_RUN_STATUSES = ["QUEUED", "RUNNING"] as const

export class AgentSelectionError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 503, readonly code: "AGENT_NOT_FOUND" | "AGENT_NOT_INVOKABLE" | "AGENT_ATTRIBUTION_UNAVAILABLE") {
    super(message)
    this.name = "AgentSelectionError"
  }
}

const NOT_AVAILABLE = "Agent not found or not available in this workspace."

/**
 * The agent a run should act as, or null for the built-in assistant (the pre-agents behaviour).
 *
 * Phase 2 accepts only an EXPLICIT agent id; the default tables (user override, workspace default) arrive
 * with phase 3 and will be consulted here when \`requestedAgentId\` is absent. Everything below runs on
 * every explicit request, so a hand-edited agent id gets no further than a picker would.
 *
 *  - It must exist, be a CLOUD agent, and be ACTIVE (a suspended agent cannot start a run).
 *  - It must hold a live grant in THIS workspace (a shared agent is also confined to the workspace that owns
 *    it, and its grants must still be backed by a current administrator). An agent with no grant here would
 *    run with no reach at all; refusing is clearer than starting a run that can do nothing.
 *  - \`canInvokeAgent\` must allow the invoker (a USER-owned agent: its owner only; a shared agent: per its policy).
 *
 * Not-found, wrong kind, suspended and not-granted all answer the same way so an id reveals nothing; only a
 * policy refusal is distinguishable, and only for an agent the caller can already see is usable here.
 */
export async function resolveRunAgent(
  prisma: AppPrismaClient,
  input: { userId: string; workspaceId: string; requestedAgentId?: string | null },
): Promise<AgentRecord | null> {
  if (input.requestedAgentId == null) return null
  if (!agentsEnabled()) throw new AgentSelectionError(NOT_AVAILABLE, 404, "AGENT_NOT_FOUND")
  const agent = await findAgentById(prisma, input.requestedAgentId)
  if (!agent || agent.status !== "ACTIVE" || agentKind(agent) !== "CLOUD") throw new AgentSelectionError(NOT_AVAILABLE, 404, "AGENT_NOT_FOUND")
  const granted = await liveGrantedWorkspaceIds(agent, "READ")
  if (!granted.includes(input.workspaceId)) throw new AgentSelectionError(NOT_AVAILABLE, 404, "AGENT_NOT_FOUND")
  if (!(await canInvokeAgent(prisma, { userId: input.userId }, agent))) {
    throw new AgentSelectionError("You are not allowed to run this agent.", 403, "AGENT_NOT_INVOKABLE")
  }
  return agent
}

/** The fields of an ApiKey row this check reads. */
export type AgentTurnKeyRow = { id: string; userId: string; agentId: string | null; scopeWorkspaceId: string | null }

/**
 * The live run an agent-scoped AGENT_TURN key belongs to, or null.
 *
 * Every predicate is a requirement:
 *   - \`apiKeyId\`: the run named THIS key (a key cannot borrow another run);
 *   - \`agentId\`: the run is attributed to the key's agent (a key for agent A can never ride a run of agent B);
 *   - \`workspaceId\` / \`userId\` / \`invokedByUserId\`: the run is in the key's workspace and was started by the
 *     key's user (no cross-workspace or cross-invoker reuse);
 *   - \`status\` non-terminal and \`deadlineAt\` in the future: a finished, canceled, swept or overdue run is dead.
 */
export async function findLiveRunForTurnKey(prisma: AppPrismaClient, key: AgentTurnKeyRow, now: Date = new Date()): Promise<{ id: string } | null> {
  if (!key.agentId || !key.scopeWorkspaceId) return null
  return prisma.agentRun.findFirst({
    where: {
      apiKeyId: key.id,
      agentId: key.agentId,
      workspaceId: key.scopeWorkspaceId,
      userId: key.userId,
      invokedByUserId: key.userId,
      status: { in: [...LIVE_AGENT_RUN_STATUSES] },
      deadlineAt: { gt: now },
    },
    select: { id: true },
  })
}

/**
 * Authorize an agent-scoped AGENT_TURN key. Returns the run id to carry on the actor, or null to reject.
 * Fail-closed throughout: agents disabled, a missing/overdue/terminal run, an agent that is gone,
 * suspended or not a CLOUD agent, a USER-owned agent whose owner is not the key's user, or any database
 * error (including migration 100 being unapplied) all reject. Never downgrades to a plain user turn.
 */
export async function authorizeAgentTurnKey(prisma: AppPrismaClient, key: AgentTurnKeyRow, now: Date = new Date()): Promise<string | null> {
  if (!agentsEnabled() || !key.agentId) return null
  try {
    const run = await findLiveRunForTurnKey(prisma, key, now)
    if (!run) return null
    const agent = await findAgentById(prisma, key.agentId)
    if (!agent) return null
    const valid = agentIdentityValidForActor(agent, { userId: key.userId, purpose: "AGENT_TURN", agentId: key.agentId, agentRunId: run.id })
    return valid ? run.id : null
  } catch {
    return null
  }
}
