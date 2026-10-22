import type { McpActor } from "@/lib/mcp-authz"

/**
 * The body of `get_current_identity`.
 *
 * A cloud run of a named agent (AGENT_TURN with an agentId) IS that agent, started by a person. Reporting the invoker as
 * `userId` would tell the agent (and anything reading its output) that it is the person, so for that case `userId` is null
 * and the person appears as `invokedByUserId`. Every other actor keeps the established shape: a personal agent key reports
 * its owner as `userId`, a person reports themselves, the built-in assistant (no agentId) reports the person it acts for.
 */
export function currentIdentityPayload(actor: Pick<McpActor, "purpose" | "userId" | "agentId">, agent: { id: string; name: string } | null, workspaces: unknown[]) {
  const cloudAgentRun = actor.purpose === "AGENT_TURN" && !!actor.agentId
  return {
    purpose: actor.purpose ?? "USER",
    userId: cloudAgentRun ? null : actor.userId,
    ...(cloudAgentRun ? { invokedByUserId: actor.userId } : {}),
    agent,
    workspaces,
  }
}
