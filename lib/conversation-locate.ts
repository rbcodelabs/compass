/**
 * Finds the conversation that holds a message or a comment id: the lookup behind old `?comment=<id>` links (TASK-195 S3).
 *
 * Ids line up for comment-origin threads (root comment id == conversation id == root message id; reply comment id ==
 * message id), but a mirror can be missing (a swallowed dual-write), so a comment id is also accepted and the mirror is
 * repaired on demand with `ensureConversationForComment`.
 *
 * Rules this module keeps:
 *  - Reads go through `accessibleConversationsWhere`, the one answer to "may this user see this conversation". Archived
 *    threads stay locatable (they stay readable by id for the people who could read them before).
 *  - "No access" and "does not exist" are the same `null`, so a caller can never learn that something exists.
 *  - Nothing is written for a caller who may not read the thread. A missing conversation is only repaired for a member of
 *    the workspace (the repaired row is workspace-visible, exactly what the dual-write would have made); an existing one
 *    is only touched after the read check passes.
 *  - A repair only happens for a comment the comments API itself would show this caller: its target must still exist, in THIS
 *    workspace, and be a kind of target comments are allowed on (the same `resolveCommentTarget` the comment routes authorize
 *    with, whose only access rule beyond that is workspace membership: there is no per-document or per-task privacy to bypass).
 *    A comment left behind on a deleted or unresolvable target is therefore never repaired into a readable conversation by
 *    this GET. The repair is also bounded (LOCATE_REPAIR_REPLY_CAP replies plus the requested comment).
 *  - Locate never moves `updatedAt`. The repo's Prisma write extension sets `updatedAt = now` on any update that omits it,
 *    so the repair paths are the S0 ones that state it explicitly: a whole-thread repair creates the conversation with
 *    the thread's own time (header insert-only, never an update, so a concurrent creator wins), and a one-message repair into an existing conversation (scope "comment") never lowers the
 *    time or overwrites a newer summary. A plain hit writes nothing.
 */

import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import type { AppPrismaClient } from "@/lib/db"
import { ensureConversationForComment } from "@/lib/conversation-mirror"
import { COMMENT_TARGET_TYPES, resolveCommentTarget, type CommentTargetType } from "@/lib/comments"

/** True when the comment's target still exists in `workspaceId` (the comments API's own authorization precondition). */
async function commentTargetReadable(comment: { targetType: string; targetId: string }, workspaceId: string): Promise<boolean> {
  const type = COMMENT_TARGET_TYPES.find((candidate) => candidate === comment.targetType) as CommentTargetType | undefined
  if (!type) return false
  const target = await resolveCommentTarget(type, comment.targetId)
  return target?.workspaceId === workspaceId
}

export type LocatedConversation = {
  conversationId: string
  messageId: string
  /** True when the message is the first one of its conversation (the root comment for a comment-origin thread). */
  isRoot: boolean
  targetType: string | null
  targetId: string | null
  status: string
  archived: boolean
}

export async function locateConversationMessage(
  prisma: AppPrismaClient,
  { workspaceId, userId, messageId }: { workspaceId: string; userId: string; messageId: string },
): Promise<LocatedConversation | null> {
  const readable = (conversationId: string) =>
    prisma.agentConversation.findFirst({
      where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
      select: { id: true, targetType: true, targetId: true, status: true, archivedAt: true },
    })

  const describe = async (conversationId: string, resolvedMessageId: string): Promise<LocatedConversation | null> => {
    const conversation = await readable(conversationId)
    if (!conversation) return null
    const first = await prisma.agentMessage.findFirst({ where: { conversationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })
    return {
      conversationId,
      messageId: resolvedMessageId,
      isRoot: resolvedMessageId === conversationId || first?.id === resolvedMessageId,
      targetType: conversation.targetType,
      targetId: conversation.targetId,
      status: conversation.status ?? "OPEN",
      archived: conversation.archivedAt != null,
    }
  }

  const message = await prisma.agentMessage.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true } })
  if (message) return describe(message.conversationId, message.id)

  const comment = await prisma.comment.findUnique({ where: { id: messageId }, select: { id: true, workspaceId: true, parentId: true, targetType: true, targetId: true } })
  if (!comment || comment.workspaceId !== workspaceId) return null
  const rootId = comment.parentId ?? comment.id

  const existing = await prisma.agentConversation.findUnique({ where: { id: rootId }, select: { id: true } })
  if (existing) {
    // The conversation is there but this message is not: repair that one message, after the read check.
    if (!(await readable(rootId))) return null
    if (!(await commentTargetReadable(comment, workspaceId))) return null
    const repaired = await ensureConversationForComment(prisma, comment.id, { scope: "comment" })
    return repaired ? describe(repaired.conversationId, repaired.messageId) : null
  }

  // No conversation at all: only a workspace member may cause one to be created, and the viewer does not become its owner.
  const membership = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { userId: true } })
  if (!membership) return null
  if (!(await commentTargetReadable(comment, workspaceId))) return null
  // "create-only": the header is inserted only if absent, so a writer that creates the conversation between the check above
  // and this write keeps its newer updatedAt, status and summary (the whole-thread rewrite would lower them).
  const repaired = await ensureConversationForComment(prisma, comment.id, { scope: "create-only" })
  return repaired ? describe(repaired.conversationId, repaired.messageId) : null
}
