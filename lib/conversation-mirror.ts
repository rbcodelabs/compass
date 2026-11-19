/**
 * The Discussion `Comment` tables are mirrored into `AgentConversation` / `AgentMessage`
 * (OPP-67 / SOL-117). The bridge is id equality: for a root comment, comment id == conversation id
 * == root message id; for a reply, comment id == message id. This module is the single owner of
 * every mirror write so the create path, the repair path and the backfill cannot drift:
 *
 *  - `mirrorCommentThread` is the one place a thread is promoted (conversation upsert, one message
 *    upsert per comment, the conversation link). The backfill and `ensureConversationForComment`
 *    both call it.
 *  - `ensureConversationForComment` repairs or creates the mirror for one comment's thread. It is
 *    idempotent and returns the same ids every time.
 *  - `mirrorCommentAfterCommit` is the dual-write hook. It runs after the comment transaction has
 *    committed (never inside it: a swallowed statement error inside a Postgres transaction poisons
 *    the transaction), on the global client, and logs instead of throwing.
 *  - `removeCommentMirror` follows a legacy hard delete of comments so no ghost conversation is left.
 *    Per the "no hard delete" rule, a thread that holds anything that is not a mirror of a deleted
 *    comment (agent runs, an interview, panel-created messages) is archived instead of purged.
 *
 * No schema change: the columns this writes were added by migration 125, and there are no foreign
 * keys (`relationMode = "prisma"`), so every delete here is explicit.
 */

import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { deriveConversationSummary } from "@/lib/agent-card-derive"
import { deleteInBatches, isMissingTable } from "@/lib/batched-delete"
import { runAfterCommit } from "@/lib/following-commit"

// lib/comments.ts (loaded almost everywhere) imports this module, so the heavy dependencies (the link service and
// the purge, which pulls in blob storage) are imported lazily, only on the paths that need them.

async function tolerateMissingTable<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isMissingTable(error)) return fallback
    throw error
  }
}

/** The one `messageKind` every comment-origin mirror message carries (readers also accept null and the older "MESSAGE"). */
export const COMMENT_MIRROR_MESSAGE_KIND = "COMMENT"
export const PLAN_PROPOSAL_MESSAGE_KIND = "PLAN_PROPOSAL"

export function commentMirrorMessageKind(isPlanProposal: boolean): string {
  return isPlanProposal ? PLAN_PROPOSAL_MESSAGE_KIND : COMMENT_MIRROR_MESSAGE_KIND
}

export function deriveConversationTitleFromComment(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^[#*>\-\s]+/, "").trim())
      .find(Boolean) ?? "Discussion thread"
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

/** The `Comment` columns the mirror reads; `solutionPlanProposal` is optional so plain rows work too. */
export type MirrorSourceComment = {
  id: string
  workspaceId: string
  targetType: string
  targetId: string
  parentId: string | null
  body: string
  status: string
  authorId: string | null
  authorName: string
  authorType: string
  source: string | null
  createdAt: Date
  updatedAt: Date
  solutionPlanProposal?: { commentId: string } | null
}

/**
 * Promotes one thread (a root and its replies) into a conversation plus messages, upserting by the
 * comment ids. Safe to repeat. Returns what it wrote.
 */
export async function mirrorCommentThread(
  prisma: AppPrismaClient,
  thread: { root: MirrorSourceComment; replies: MirrorSourceComment[]; ownerUserId: string },
): Promise<{ messagesPromoted: number; linkCreated: boolean }> {
  const { root, replies, ownerUserId } = thread
  const allMessages = [root, ...replies]
  const lastMessage = allMessages[allMessages.length - 1]!
  const updatedAt = lastMessage.updatedAt > root.updatedAt ? lastMessage.updatedAt : root.updatedAt
  const title = deriveConversationTitleFromComment(root.body)
  const summary = deriveConversationSummary(lastMessage.body) ?? title.slice(0, 140)
  const status = root.status === "RESOLVED" ? "RESOLVED" : "OPEN"
  const resolvedAt = status === "RESOLVED" ? root.updatedAt : null

  await prisma.agentConversation.upsert({
    where: { id: root.id },
    create: {
      id: root.id,
      workspaceId: root.workspaceId,
      userId: ownerUserId,
      title,
      summary,
      targetType: root.targetType,
      targetId: root.targetId,
      visibility: "WORKSPACE",
      status,
      agentMode: "MENTION_ONLY",
      source: root.source ?? "BROWSER",
      resolvedAt,
      resolvedById: null,
      createdAt: root.createdAt,
      updatedAt,
    },
    update: { status, resolvedAt, summary, updatedAt },
  })

  let messagesPromoted = 0
  for (const item of allMessages) {
    const isAssistant = item.authorType === "AGENT" || item.authorType === "AI"
    const role = isAssistant ? "assistant" : "user"
    const editedAt = item.updatedAt > item.createdAt ? item.updatedAt : null
    const messageKind = commentMirrorMessageKind(Boolean(item.solutionPlanProposal))
    await prisma.agentMessage.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        conversationId: root.id,
        role,
        content: item.body,
        authorUserId: item.authorId,
        authorName: item.authorName,
        authorType: item.authorType ?? (isAssistant ? "AGENT" : "HUMAN"),
        messageKind,
        editedAt,
        createdAt: item.createdAt,
      },
      // The kind is rewritten too so a row dual-written as "MESSAGE" converges on the shared value.
      update: { content: item.body, editedAt, messageKind },
    })
    messagesPromoted++
  }

  let linkCreated = false
  const { isConversationLinkTarget, recordConversationLink } = await import("@/lib/links/conversation-links")
  if (isConversationLinkTarget(root.targetType)) {
    try {
      linkCreated =
        (await recordConversationLink(prisma, {
          conversationId: root.id,
          workspaceId: root.workspaceId,
          entityType: root.targetType,
          entityId: root.targetId,
          kind: "MENTIONS",
        })) === "created"
    } catch {
      // Best-effort if the target entity was deleted.
    }
  }
  return { messagesPromoted, linkCreated }
}

/**
 * Creates or repairs the mirror for the thread containing `commentId`. Idempotent: the ids are the
 * comment ids, so a second call returns the same pair and writes no new rows. Returns null when the
 * comment (or, for a reply, its root) no longer exists, or when no member can own the conversation.
 */
export async function ensureConversationForComment(
  prisma: AppPrismaClient,
  commentId: string,
  options: { fallbackUserId?: string } = {},
): Promise<{ conversationId: string; messageId: string } | null> {
  const include = { solutionPlanProposal: { select: { commentId: true } } }
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, include })
  if (!comment) return null
  const root = comment.parentId ? await prisma.comment.findUnique({ where: { id: comment.parentId }, include }) : comment
  if (!root) return null

  let ownerUserId = root.authorId ?? options.fallbackUserId ?? null
  if (!ownerUserId) {
    const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: root.workspaceId }, select: { userId: true } })
    ownerUserId = member?.userId ?? null
  }
  if (!ownerUserId) return null

  const replies = await prisma.comment.findMany({ where: { parentId: root.id }, include, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  await mirrorCommentThread(prisma, { root, replies, ownerUserId })
  return { conversationId: root.id, messageId: comment.id }
}

/**
 * Dual-write hook for a comment that has just committed. Never throws: the comment is the source of
 * truth and a missing mirror is repaired on demand by `ensureConversationForComment`. Queues until the
 * outer transaction commits when called inside `withFollowingCommit`.
 */
export async function mirrorCommentAfterCommit(commentId: string): Promise<void> {
  await runAfterCommit(async () => {
    try {
      await ensureConversationForComment(getPrisma(), commentId)
    } catch (error) {
      console.error("[conversation-mirror] dual-write failed", error)
    }
  })
}

export type RemoveCommentMirrorInput = {
  /** The root comment id, which is also the conversation id. */
  conversationId: string
  /** Every comment id that was deleted (the root's and its replies', or just a reply's). */
  commentIds: string[]
  /** True when the root comment itself was deleted. */
  threadDeleted: boolean
}

/**
 * Removes the mirror of deleted comments. The deleted comments' own messages always go. When the
 * root was deleted the conversation goes too, unless it holds anything that is not a mirror of a
 * deleted comment, in which case it is archived (restorable) rather than hard-deleted.
 */
export async function removeCommentMirror(prisma: AppPrismaClient, input: RemoveCommentMirrorInput): Promise<void> {
  const { conversationId, commentIds, threadDeleted } = input
  const ids = [...new Set(commentIds)]
  if (ids.length > 0) await deleteInBatches(prisma.agentMessage, { id: { in: ids }, conversationId })
  if (!threadDeleted) return

  const conversation = await prisma.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, interviewProcessingJson: true },
  })
  if (!conversation) return

  const otherMessages = await prisma.agentMessage.count({ where: { conversationId, id: { notIn: ids } } })
  const runs = await tolerateMissingTable(() => prisma.agentRun.count({ where: { conversationId } }), 0)
  const childRuns = await tolerateMissingTable(() => prisma.agentChildRun.count({ where: { conversationId } }), 0)
  const hasActivity = otherMessages > 0 || runs > 0 || childRuns > 0 || Boolean(conversation.interviewProcessingJson)

  if (hasActivity) {
    await prisma.agentConversation.updateMany({ where: { id: conversationId, archivedAt: null }, data: { archivedAt: new Date() } })
    return
  }
  const { purgeConversations } = await import("@/lib/agent-conversation-purge")
  await purgeConversations(prisma, [conversationId])
}

/** After-commit wrapper for `removeCommentMirror`: logs and swallows, so a mirror failure never fails the delete. */
export async function removeCommentMirrorAfterCommit(input: RemoveCommentMirrorInput): Promise<void> {
  await runAfterCommit(async () => {
    try {
      await removeCommentMirror(getPrisma(), input)
    } catch (error) {
      console.error("[conversation-mirror] mirror removal failed", error)
    }
  })
}
