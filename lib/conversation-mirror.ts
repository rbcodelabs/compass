/**
 * The Discussion `Comment` tables are mirrored into `AgentConversation` / `AgentMessage`
 * (OPP-67 / SOL-117). The bridge is id equality: for a root comment, comment id == conversation id
 * == root message id; for a reply, comment id == message id. This module is the single owner of
 * every mirror write so the create path, the repair path and the backfill cannot drift:
 *
 *  - `mirrorCommentThread` is the one place a thread is promoted (conversation upsert, message
 *    upserts, the conversation link). The backfill and `ensureConversationForComment` both call it.
 *  - `ensureConversationForComment` repairs or creates the mirror for one comment's thread. It is
 *    idempotent and returns the same ids every time.
 *  - `mirrorCommentAfterCommit` is the dual-write hook. It runs after the comment transaction has
 *    committed (never inside it: a swallowed statement error inside a Postgres transaction poisons
 *    the transaction), on the global client, and logs instead of throwing. It writes only the new
 *    comment's message, and never lowers `updatedAt` or overwrites a newer summary that a panel
 *    message or an agent run set.
 *  - `removeCommentMirror` follows a legacy hard delete of comments so no ghost conversation (and no
 *    deleted text) is left behind.
 *
 * NAMED EXCEPTION TO "NO HARD DELETE" (Rick's rule, design section 10). The PURGE branch of
 * `removeCommentMirror` hard-deletes a conversation, but only when every row in it is a mirror of a
 * comment that the legacy API has itself just hard-deleted, so there is no user content to lose.
 * Archiving such a mirror would keep the deleted text readable, which is worse. It is a data-hygiene
 * path for legacy comment deletes ONLY. It must never be reused by the new-model Delete/Archive
 * action (slice S2), which archives. Anything that is not a pure mirror is archived here too, with
 * its title and summary blanked so the deleted comment's text is not visible on the row.
 *
 * S1 NOTE: an edit made through the conversation surface must write BOTH the `Comment` row and the
 * `AgentMessage` row. This module treats the Comment as the source of truth for comment-origin
 * messages, so a later repair or backfill (`mirrorCommentThread`) overwrites the message content
 * from the Comment and would silently clobber an edit that only touched the message.
 *
 * No schema change: the columns this writes were added by migration 125, and there are no foreign
 * keys (`relationMode = "prisma"`), so every delete here is explicit.
 */

import getPrisma from "@/lib/db"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { deriveConversationSummary } from "@/lib/agent-card-derive"
import { isMissingTable, pages } from "@/lib/batched-delete"
import { runAfterCommit } from "@/lib/following-commit"

// lib/comments.ts (loaded almost everywhere) imports this module, so the heavier dependencies (the link
// service and the conversation-link recorder) are imported lazily, only on the paths that need them.

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
/** Neutral title for an archived conversation whose source comment was deleted. */
export const ARCHIVED_MIRROR_TITLE = "Archived conversation"

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
 *
 * With `onlyCommentId` (the create path) only that comment's message is written, and an existing
 * conversation keeps its `updatedAt` and summary unless this comment is newer, so a panel message or
 * agent run that landed in the meantime is never overwritten. Without it (backfill, repair) the whole
 * thread is rewritten from the comments.
 */
export async function mirrorCommentThread(
  prisma: AppPrismaClient,
  thread: { root: MirrorSourceComment; replies: MirrorSourceComment[]; ownerUserId: string; onlyCommentId?: string },
): Promise<{ messagesPromoted: number; linkCreated: boolean }> {
  const { root, replies, ownerUserId, onlyCommentId } = thread
  const allMessages = [root, ...replies]
  const lastMessage = allMessages[allMessages.length - 1]!
  const threadUpdatedAt = lastMessage.updatedAt > root.updatedAt ? lastMessage.updatedAt : root.updatedAt
  const title = deriveConversationTitleFromComment(root.body)
  const status = root.status === "RESOLVED" ? "RESOLVED" : "OPEN"
  // `Comment` has no resolve timestamp; the resolve bumps the root's updatedAt, which is the best real time available.
  const resolvedAt = status === "RESOLVED" ? root.updatedAt : null
  const createHeader = (summary: string, updatedAt: Date) => ({
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
  })

  const items = onlyCommentId ? allMessages.filter((item) => item.id === onlyCommentId) : allMessages
  if (onlyCommentId) {
    const target = items[0]
    const existing = await prisma.agentConversation.findUnique({ where: { id: root.id }, select: { updatedAt: true } })
    const targetSummary = deriveConversationSummary(target?.body ?? "") ?? title.slice(0, 140)
    const newer = Boolean(target && existing && target.updatedAt > existing.updatedAt)
    await prisma.agentConversation.upsert({
      where: { id: root.id },
      create: createHeader(deriveConversationSummary(lastMessage.body) ?? title.slice(0, 140), threadUpdatedAt),
      update: newer && target ? { summary: targetSummary, updatedAt: target.updatedAt } : {},
    })
  } else {
    const summary = deriveConversationSummary(lastMessage.body) ?? title.slice(0, 140)
    await prisma.agentConversation.upsert({
      where: { id: root.id },
      create: createHeader(summary, threadUpdatedAt),
      // Reopening clears the resolve markers; a resolved thread keeps whatever resolve time is already stored.
      update: { status, summary, updatedAt: threadUpdatedAt, ...(status === "OPEN" ? { resolvedAt: null, resolvedById: null } : {}) },
    })
    if (status === "RESOLVED") {
      await prisma.agentConversation.updateMany({ where: { id: root.id, resolvedAt: null }, data: { resolvedAt } })
    }
  }

  let messagesPromoted = 0
  for (const item of items) {
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
 * `scope: "comment"` is the create path (see `mirrorCommentThread`); the default rewrites the thread.
 */
export async function ensureConversationForComment(
  prisma: AppPrismaClient,
  commentId: string,
  options: { fallbackUserId?: string; scope?: "thread" | "comment" } = {},
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
  await mirrorCommentThread(prisma, { root, replies, ownerUserId, ...(options.scope === "comment" ? { onlyCommentId: comment.id } : {}) })

  // Create-vs-delete race: if the comment (or its root) was deleted while we wrote, undo what we wrote so no ghost remains.
  const rootStillThere = await prisma.comment.findUnique({ where: { id: root.id }, select: { id: true } })
  if (!rootStillThere) {
    await removeCommentMirror(prisma, { conversationId: root.id, commentIds: [root.id, ...replies.map((reply) => reply.id)], threadDeleted: true })
    return null
  }
  if (comment.id !== root.id && !(await prisma.comment.findUnique({ where: { id: comment.id }, select: { id: true } }))) {
    await removeCommentMirror(prisma, { conversationId: root.id, commentIds: [comment.id], threadDeleted: false })
    return null
  }
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
      await ensureConversationForComment(getPrisma(), commentId, { scope: "comment" })
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

const MESSAGE_PAGE = 500

async function deleteMirrorMessages(db: AppTransactionClient, conversationId: string, ids: string[]): Promise<string[]> {
  const authorIds: string[] = []
  for (const page of pages(ids, MESSAGE_PAGE)) {
    const rows = await db.agentMessage.findMany({ where: { conversationId, id: { in: page } }, select: { authorUserId: true } })
    for (const row of rows) if (row.authorUserId) authorIds.push(row.authorUserId)
    await db.agentMessage.deleteMany({ where: { conversationId, id: { in: page } } })
  }
  return authorIds
}

function isRetryable(error: unknown): boolean {
  const value = error as { code?: string; meta?: { code?: string }; message?: string }
  return value.code === "P2034" || value.code === "40001" || value.meta?.code === "40001" || /OC00\d|serialization/i.test(value.message ?? "")
}

/**
 * Anything in the conversation that is not a mirror of a deleted comment: other messages, agent
 * runs, queued work, reviews, audit rows, transcripts, web rows, an interview, a non-comment
 * participant, or an origin link. Missing tables count as empty.
 */
async function hasNonMirrorContent(
  db: AppTransactionClient,
  conversation: { id: string; userId: string; interviewProcessingJson: string | null },
  commentAuthorIds: string[],
): Promise<boolean> {
  if (conversation.interviewProcessingJson) return true
  const conversationId = conversation.id
  const { countNonMirrorConversationLinks } = await import("@/lib/links/conversation-links")
  const mirrorUsers = [...new Set([conversation.userId, ...commentAuthorIds])]
  const counts: Array<() => Promise<number>> = [
    () => db.agentMessage.count({ where: { conversationId } }),
    () => db.agentRun.count({ where: { conversationId } }),
    () => db.agentChildRun.count({ where: { conversationId } }),
    () => db.agentInboxItem.count({ where: { conversationId } }),
    () => db.agentScheduledWakeup.count({ where: { conversationId } }),
    () => db.agentConversationParticipant.count({ where: { conversationId, userId: { notIn: mirrorUsers } } }),
    () => db.agentConversationReview.count({ where: { conversationId } }),
    () => db.agentAuditLog.count({ where: { conversationId } }),
    () => db.agentSession.count({ where: { conversationId } }),
    () => db.agentWebSearch.count({ where: { conversationId } }),
    () => db.agentWebFetch.count({ where: { conversationId } }),
    () => db.pMInterview.count({ where: { agentConversationId: conversationId } }),
    () => db.apiKey.count({ where: { scopeConversationId: conversationId } }),
    // The mirror's own CONVERSATION_MENTIONS link is not content; any other link (task origin, CREATED) is.
    () => countNonMirrorConversationLinks(db, conversationId),
  ]
  for (const count of counts) if ((await tolerateMissingTable(count, 0)) > 0) return true
  return false
}

/**
 * Removes the mirror of deleted comments.
 *
 * The deleted comments' own messages always go. For a reply delete the conversation's summary and
 * updatedAt are recomputed from the latest remaining message so the deleted text is not left in the
 * list. For a root delete, in ONE RepeatableRead transaction (so a panel message posted meanwhile is
 * either counted or conflicts and retries, never destroyed): if the conversation holds anything that is
 * not a mirror of a deleted comment it is ARCHIVED with a neutral title and no summary; otherwise it is
 * purged (the named hard-delete exception in the module header).
 */
export async function removeCommentMirror(prisma: AppPrismaClient, input: RemoveCommentMirrorInput): Promise<void> {
  const { conversationId, commentIds, threadDeleted } = input
  const ids = [...new Set(commentIds)]

  if (!threadDeleted) {
    await deleteMirrorMessages(prisma, conversationId, ids)
    const latest = await prisma.agentMessage.findFirst({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { content: true, createdAt: true, editedAt: true },
    })
    if (!latest) return
    const updatedAt = latest.editedAt && latest.editedAt > latest.createdAt ? latest.editedAt : latest.createdAt
    await prisma.agentConversation.updateMany({
      where: { id: conversationId },
      data: { summary: deriveConversationSummary(latest.content) ?? null, updatedAt },
    })
    return
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction((tx) => removeDeletedThread(tx, conversationId, ids), { isolationLevel: "RepeatableRead" })
      return
    } catch (error) {
      if (!isRetryable(error) || attempt >= 2) throw error
    }
  }
}

async function removeDeletedThread(tx: AppTransactionClient, conversationId: string, ids: string[]): Promise<void> {
  const conversation = await tx.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, interviewProcessingJson: true, updatedAt: true, archivedAt: true },
  })
  if (!conversation) {
    await deleteMirrorMessages(tx, conversationId, ids)
    return
  }
  // Write the conversation row first: a concurrent turn also writes it, so the two conflict under RepeatableRead and one retries.
  await tx.agentConversation.updateMany({ where: { id: conversationId }, data: { updatedAt: conversation.updatedAt } })
  const authorIds = await deleteMirrorMessages(tx, conversationId, ids)

  if (await hasNonMirrorContent(tx, conversation, authorIds)) {
    await tx.agentConversation.updateMany({
      where: { id: conversationId },
      data: { archivedAt: conversation.archivedAt ?? new Date(), title: ARCHIVED_MIRROR_TITLE, summary: null },
    })
    return
  }
  // Pure mirror: hard delete, children first (no FKs). See the named exception in the module header.
  const { deleteLinksForEntity } = await import("@/lib/links/service")
  await tolerateMissingTable(() => tx.agentConversationParticipant.deleteMany({ where: { conversationId } }), { count: 0 })
  await deleteLinksForEntity(tx, "AGENT_CONVERSATION", [conversationId])
  await tx.agentConversation.deleteMany({ where: { id: conversationId } })
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
