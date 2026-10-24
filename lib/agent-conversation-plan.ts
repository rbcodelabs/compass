/**
 * The agent's plan for one conversation, read back from the Compass tasks it created with TaskCreate
 * (source AGENT, linked via AGENT_CONVERSATION). This is what lets the chat's plan card survive a reload and
 * be seen by participants, which the per-turn TodoWrite list never could.
 */
import type { AppPrismaClient } from "@/lib/db"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { toAgentStatus } from "@/lib/agent-task-tools"

export type ConversationPlanItem = { taskId: string; content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }

/** Null when the caller may not see the conversation (the route answers 404, never 403). */
export async function listConversationPlan(
  prisma: AppPrismaClient,
  { conversationId, workspaceId, userId }: { conversationId: string; workspaceId: string; userId: string },
): Promise<ConversationPlanItem[] | null> {
  if (!(await resolveConversationAccess(prisma, { conversationId, workspaceId, userId }))) return null
  const rows = await prisma.task.findMany({
    where: { workspaceId, status: { not: "CANCELLED" }, links: { some: { linkedType: "AGENT_CONVERSATION", linkedId: conversationId } } },
    select: { id: true, title: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map((t) => ({ taskId: t.id, content: t.title, activeForm: t.title, status: toAgentStatus(t.status) }))
}
