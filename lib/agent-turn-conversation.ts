/**
 * The agent conversation the current MCP call belongs to. The conversation is never a tool argument: it is resolved from the
 * calling turn key's live AgentRun (AgentRun.apiKeyId), so a model cannot act on, or be attributed to, another conversation.
 * Shared by the agent task tools (lib/agent-task-tools.ts) and the conversation links (lib/links/conversation-links.ts).
 */
import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"

export type AgentTurnConversation = { conversationId: string; workspaceId: string }

/** Null outside an agent turn (a person, a service key, a standalone agent) or when the turn's run is no longer live. */
export async function currentAgentConversation(): Promise<AgentTurnConversation | null> {
  const actor = getMcpActor()
  if (actor.purpose !== "AGENT_TURN" || !actor.credentialId) return null
  const run = await getPrisma().agentRun.findFirst({
    where: { apiKeyId: actor.credentialId, status: { in: ["QUEUED", "RUNNING"] } },
    select: { conversationId: true, workspaceId: true },
  })
  return run ? { conversationId: run.conversationId, workspaceId: run.workspaceId } : null
}
