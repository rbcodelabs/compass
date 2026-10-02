/**
 * Shared core logic for inline doc comments, used by BOTH the MCP tool handlers
 * (lib/doc-comment-tool-handlers.ts) and the UI server actions
 * (app/[orgSlug]/[workspaceSlug]/docs/actions.ts) so the two paths can never
 * drift on the rules that matter:
 *
 *   - Threads are exactly one level deep. A reply (parentId set) must attach to
 *     an existing ROOT comment (a comment whose own parentId is null).
 *   - Replies never carry an anchor — only root comments anchor into the doc.
 *   - Deleting a root deletes its replies first (no FK cascade on DSQL), then
 *     the root. Deleting a reply just deletes that row.
 *   - Every update sets updatedAt explicitly (DSQL has no @updatedAt trigger).
 *
 * These functions do the database work and return plain results; the callers
 * own auth, response formatting, and revalidation.
 */

import getPrisma from "@/lib/db"
import { resolveCommentAuthors } from "@/lib/comment-authors"
import type { DocComment } from "@prisma/client"
import { createCommentRows, followAfterComment, type CommentSource } from "@/lib/comments"

export type CommentStatus = "OPEN" | "RESOLVED"
export type CommentAuthorType = "AGENT" | "HUMAN"

export interface CommentAnchorFields {
  anchorText?: string | null
  anchorPrefix?: string | null
  anchorSuffix?: string | null
  anchorStart?: number | null
  anchorEnd?: number | null
}

export interface CreateDocCommentInput extends CommentAnchorFields {
  docId: string
  body: string
  authorName: string
  authorId?: string | null
  authorType?: CommentAuthorType
  source?: CommentSource
  parentId?: string | null
}

export type CreateDocCommentResult =
  | { ok: true; comment: DocComment }
  | { ok: false; error: "DOC_NOT_FOUND" | "PARENT_NOT_FOUND" | "PARENT_IS_REPLY" | "EMPTY_BODY" }

/**
 * Create a root comment or a reply. Enforces the one-level-deep thread rule and
 * strips anchor fields from replies (only roots anchor into the doc).
 */
export async function createDocCommentCore(
  input: CreateDocCommentInput
): Promise<CreateDocCommentResult> {
  const prisma = getPrisma()

  const body = input.body.trim()
  if (!body) return { ok: false, error: "EMPTY_BODY" }

  const result = await prisma.$transaction(async tx => {
    const doc = await tx.doc.findUnique({ where: { id: input.docId }, select: { id: true, workspaceId: true } })
    if (!doc) return { ok: false as const, error: "DOC_NOT_FOUND" as const }
    const isReply = Boolean(input.parentId)
    if (isReply) {
      const parent = await tx.docComment.findUnique({ where: { id: input.parentId! }, select: { id: true, parentId: true, docId: true } })
      if (!parent || parent.docId !== input.docId) return { ok: false as const, error: "PARENT_NOT_FOUND" as const }
      if (parent.parentId) return { ok: false as const, error: "PARENT_IS_REPLY" as const }
    }
    const comment = await tx.docComment.create({ data: {
      docId: input.docId,
      parentId: input.parentId ?? null,
      body,
      status: "OPEN",
      // Replies never anchor — only roots carry anchor context.
      anchorText: isReply ? null : input.anchorText ?? null,
      anchorPrefix: isReply ? null : input.anchorPrefix ?? null,
      anchorSuffix: isReply ? null : input.anchorSuffix ?? null,
      anchorStart: isReply ? null : input.anchorStart ?? null,
      anchorEnd: isReply ? null : input.anchorEnd ?? null,
      authorName: input.authorName,
      authorId: input.authorId ?? null,
      authorType: input.authorType ?? "HUMAN",
      source: input.source ?? "UI",
    } })
    await createCommentRows(tx, {
      id: comment.id, workspaceId: doc.workspaceId, targetType: "DOC", targetId: input.docId,
      parentId: comment.parentId, body: comment.body, status: comment.status as CommentStatus,
      authorId: comment.authorId, authorName: comment.authorName,
      authorType: comment.authorType as CommentAuthorType, source: comment.source as CommentSource,
      createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      ...(comment.anchorText ? { docAnchor: { anchorText: comment.anchorText, anchorPrefix: comment.anchorPrefix, anchorSuffix: comment.anchorSuffix, anchorStart: comment.anchorStart, anchorEnd: comment.anchorEnd } } : {}),
    })
    return { ok: true as const, comment, workspaceId: doc.workspaceId }
  })
  if (!result.ok) return result
  await followAfterComment({ id: result.comment.id, workspaceId: result.workspaceId, targetType: "DOC", targetId: input.docId, parentId: result.comment.parentId, body: result.comment.body, status: "OPEN", authorId: result.comment.authorId, authorName: result.comment.authorName, authorType: result.comment.authorType as CommentAuthorType, source: result.comment.source as CommentSource }, result.comment.id)
  return { ok: true, comment: (await resolveCommentAuthors([result.comment]))[0] }
}

/**
 * List a doc's comments, optionally filtered by status. Returns a flat list
 * ordered oldest-first so callers can group roots + replies into threads
 * (a reply always sorts after its root by createdAt).
 */
export async function listDocCommentsCore(
  docId: string,
  status?: CommentStatus
): Promise<DocComment[]> {
  const prisma = getPrisma()
  const comments = await prisma.docComment.findMany({
    where: { docId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "asc" },
  })
  return resolveCommentAuthors(comments)
}

export async function getDocCommentCore(commentId: string): Promise<DocComment | null> {
  const prisma = getPrisma()
  const comment = await prisma.docComment.findUnique({ where: { id: commentId } })
  return comment ? (await resolveCommentAuthors([comment]))[0] : null
}

/**
 * Update a comment's body. Returns null if the comment no longer exists.
 * updatedAt is set explicitly (no DSQL trigger).
 */
export async function updateDocCommentBodyCore(
  commentId: string,
  body: string
): Promise<DocComment | null> {
  const prisma = getPrisma()
  const updated = await prisma.$transaction(async tx => {
    const existing = await tx.docComment.findUnique({ where: { id: commentId }, select: { id: true } })
    if (!existing) return null
    const now = new Date(), trimmed = body.trim()
    const row = await tx.docComment.update({ where: { id: commentId }, data: { body: trimmed, updatedAt: now } })
    const mirror = await tx.comment.updateMany({ where: { id: commentId }, data: { body: trimmed, updatedAt: now } })
    if (mirror.count !== 1) throw new Error("Doc comment shared mirror is missing.")
    return row
  })
  if (!updated) return null
  return (await resolveCommentAuthors([updated]))[0]
}

/**
 * Set a comment's status (OPEN | RESOLVED). Returns null if it no longer
 * exists. Resolving/reopening a root does not touch its replies' status.
 */
export async function setDocCommentStatusCore(
  commentId: string,
  status: CommentStatus
): Promise<DocComment | null> {
  const prisma = getPrisma()
  const updated = await prisma.$transaction(async tx => {
    const existing = await tx.docComment.findUnique({ where: { id: commentId }, select: { id: true } })
    if (!existing) return null
    const now = new Date()
    const row = await tx.docComment.update({ where: { id: commentId }, data: { status, updatedAt: now } })
    const mirror = await tx.comment.updateMany({ where: { id: commentId }, data: { status, updatedAt: now } })
    if (mirror.count !== 1) throw new Error("Doc comment shared mirror is missing.")
    return row
  })
  if (!updated) return null
  return (await resolveCommentAuthors([updated]))[0]
}

/**
 * Delete a comment. If it's a root, its replies are deleted first (DSQL has no
 * FK cascade). If it's a reply, only that row is deleted. Returns null if the
 * comment didn't exist, otherwise the deleted comment's identity.
 */
export async function deleteDocCommentCore(
  commentId: string
): Promise<{ id: string; wasRoot: boolean; deletedReplies: number } | null> {
  const prisma = getPrisma()
  return prisma.$transaction(async tx => {
    const existing = await tx.docComment.findUnique({ where: { id: commentId }, select: { id: true, parentId: true } })
    if (!existing) return null
    const wasRoot = existing.parentId === null
    const replies = wasRoot ? await tx.docComment.findMany({ where: { parentId: commentId }, select: { id: true } }) : []
    const sharedReplies = wasRoot ? await tx.comment.findMany({ where: { parentId: commentId }, select: { id: true } }) : []
    const ids = [...new Set([commentId, ...replies.map(row => row.id), ...sharedReplies.map(row => row.id)])]
    await tx.docCommentAnchor.deleteMany({ where: { commentId: { in: ids } } })
    await tx.solutionPlanProposal.deleteMany({ where: { commentId: { in: ids } } })
    await tx.commentElementAnchor.deleteMany({ where: { commentId: { in: ids } } })
    await tx.commentExternalAuthor.deleteMany({ where: { commentId: { in: ids } } })
    if (wasRoot) await tx.comment.deleteMany({ where: { parentId: commentId } })
    await tx.comment.deleteMany({ where: { id: commentId } })
    if (wasRoot) await tx.docComment.deleteMany({ where: { parentId: commentId } })
    await tx.docComment.delete({ where: { id: commentId } })
    return { id: existing.id, wasRoot, deletedReplies: replies.length }
  })
}
