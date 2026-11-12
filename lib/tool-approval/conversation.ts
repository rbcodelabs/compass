/**
 * Tells the in-app agent how an approval ended, in the only way its next turn can see: a message in the conversation history.
 * Done server-side from stored state after the human acted (or, later, when the card first observes the final state); the client
 * sends nothing but a conversation id, which is checked against the acting person's own access.
 *
 * Guarantees:
 *  - only FINAL states are ever told (never "pending" or "running");
 *  - the text is a fixed template (see conversationUpdateText), no stored or agent-supplied text;
 *  - one message per (conversation, request, state), enforced by the row's primary key, so concurrent writers cannot double it;
 *  - the conversation must belong to whoever raised the request (a run by that agent, or by that person for the built-in agent),
 *    otherwise nothing is written: a card pointed at someone else's request cannot put words in an unrelated chat.
 */
import { createHash } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"
import { authorColumn } from "@/lib/agent-attribution"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { conversationUpdateText } from "@/lib/tool-approval/messages"
import { APPROVAL_STATES, type ApprovalStateKey } from "@/lib/tool-approval/state"
import { loadApprovalRequester, type ApprovalView } from "@/lib/tool-approval/view"

export type ConversationUpdate = "added" | "duplicate" | "no_access" | "not_terminal" | "not_scoped"

/** A uuid derived from the three things that make a message unique, so the primary key itself is the dedupe lock. */
export function approvalUpdateMessageId(conversationId: string, requestId: string, state: ApprovalStateKey): string {
  const hex = createHash("sha256").update(`tool-approval-update|${conversationId}|${requestId}|${state}`).digest("hex")
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function conversationBelongsToRequester(prisma: AppPrismaClient, input: { conversationId: string; workspaceId: string; requestId: string }): Promise<boolean> {
  const requester = await loadApprovalRequester(prisma, { requestId: input.requestId, workspaceId: input.workspaceId })
  if (!requester || (!requester.agentId && !requester.userId)) return false
  try {
    const run = await prisma.agentRun.findFirst({
      where: {
        conversationId: input.conversationId, workspaceId: input.workspaceId,
        ...(requester.agentId ? { agentId: requester.agentId } : { agentId: null, userId: requester.userId! }),
      },
      select: { id: true },
    })
    return Boolean(run)
  } catch {
    // The run table cannot say which agent ran (older schema): fail closed.
    return false
  }
}

export async function addApprovalUpdateToConversation(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string; view: Pick<ApprovalView, "requestId" | "displayId" | "tool"> & { state: { key: ApprovalStateKey } } },
): Promise<ConversationUpdate> {
  const state = input.view.state.key
  if (!APPROVAL_STATES[state].terminal) return "not_terminal"
  const access = await resolveConversationAccess(prisma, { conversationId: input.conversationId, workspaceId: input.workspaceId, userId: input.userId })
  if (!access) return "no_access"
  if (!(await conversationBelongsToRequester(prisma, { conversationId: input.conversationId, workspaceId: input.workspaceId, requestId: input.view.requestId }))) return "not_scoped"
  const content = conversationUpdateText({ state, requestId: input.view.requestId, displayId: input.view.displayId, tool: input.view.tool })
  // Rows written before the deterministic id existed, or by another path, are caught by content as well.
  if (await prisma.agentMessage.findFirst({ where: { conversationId: input.conversationId, role: "user", content }, select: { id: true } })) return "duplicate"
  try {
    await prisma.agentMessage.create({
      data: { id: approvalUpdateMessageId(input.conversationId, input.view.requestId, state), conversationId: input.conversationId, role: "user", content, ...(await authorColumn(prisma, input.userId)) },
      select: { id: true },
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return "duplicate"
    throw error
  }
  return "added"
}
