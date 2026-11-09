/**
 * Tells the in-app agent how an approval ended, in the only way its next turn can see: a message in the conversation history.
 * Done server-side from the stored state after the human acted; the client sends nothing but a conversation id, which is
 * checked against the acting person's own access. The text is a fixed template (see conversationUpdateText).
 */
import type { AppPrismaClient } from "@/lib/db"
import { authorColumn } from "@/lib/agent-attribution"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { conversationUpdateText } from "@/lib/tool-approval/messages"
import type { ApprovalView } from "@/lib/tool-approval/view"

export type ConversationUpdate = "added" | "duplicate" | "no_access"

export async function addApprovalUpdateToConversation(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string; view: Pick<ApprovalView, "requestId" | "displayId" | "tool" | "state"> },
): Promise<ConversationUpdate> {
  const access = await resolveConversationAccess(prisma, { conversationId: input.conversationId, workspaceId: input.workspaceId, userId: input.userId })
  if (!access) return "no_access"
  const content = conversationUpdateText({ state: input.view.state.key, requestId: input.view.requestId, displayId: input.view.displayId, tool: input.view.tool })
  // The same outcome of the same request is told once, however many times the buttons are clicked or the page replays.
  if (await prisma.agentMessage.findFirst({ where: { conversationId: input.conversationId, role: "user", content }, select: { id: true } })) return "duplicate"
  await prisma.agentMessage.create({
    data: { conversationId: input.conversationId, role: "user", content, ...(await authorColumn(prisma, input.userId)) },
    select: { id: true },
  })
  return "added"
}
