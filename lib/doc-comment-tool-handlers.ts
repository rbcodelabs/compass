/**
 * Handler functions for the DocComment MCP tools (add_doc_comment,
 * list_doc_comments, get_doc_comment, update_doc_comment, delete_doc_comment,
 * resolve_doc_comment, reopen_doc_comment).
 *
 * Extracted into this module (rather than left inline in app/api/mcp/route.ts)
 * so every tool — including add_doc_comment, which the codebase convention
 * otherwise leaves inline — can be unit-tested. Read/write symmetry for this
 * entity is required per .claude/pr-guidelines.md.
 *
 * The real create/list/update/delete/status rules (one-level-deep threads,
 * anchor-strip-on-reply, delete-replies-before-root) live in lib/doc-comments.ts
 * and are shared with the UI server actions — these handlers add MCP identity
 * (fixed AGENT author, source "MCP") and response-text formatting.
 *
 * MCP tool handlers have no access to a resolved per-user identity —
 * validateMcpAuth is only checked once at the top of the route as a gate — so
 * authorName is an explicit input here, never derived.
 */

import getPrisma from "@/lib/db"
import {
  createDocCommentCore,
  listDocCommentsCore,
  getDocCommentCore,
  updateDocCommentBodyCore,
  setDocCommentStatusCore,
  deleteDocCommentCore,
  type CommentStatus,
} from "@/lib/doc-comments"

const MCP_SOURCE = "MCP"

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

// ── add_doc_comment ─────────────────────────────────────────────────────────
// Omit all four anchor fields → a doc-level general comment. Pass parentId →
// a reply to an existing root comment (replies never anchor).

export async function addDocComment({
  docId,
  body,
  authorName,
  parentId,
  anchorText,
  anchorPrefix,
  anchorSuffix,
  anchorStart,
  anchorEnd,
}: {
  docId: string
  body: string
  authorName: string
  parentId?: string
  anchorText?: string
  anchorPrefix?: string
  anchorSuffix?: string
  anchorStart?: number
  anchorEnd?: number
}) {
  const result = await createDocCommentCore({
    docId,
    body,
    authorName,
    authorType: "AGENT",
    source: MCP_SOURCE,
    parentId: parentId ?? null,
    anchorText: anchorText ?? null,
    anchorPrefix: anchorPrefix ?? null,
    anchorSuffix: anchorSuffix ?? null,
    anchorStart: anchorStart ?? null,
    anchorEnd: anchorEnd ?? null,
  })

  if (!result.ok) {
    const message =
      result.error === "DOC_NOT_FOUND"
        ? `Doc "${docId}" not found.`
        : result.error === "PARENT_NOT_FOUND"
          ? `Parent comment "${parentId}" not found on this doc.`
          : result.error === "PARENT_IS_REPLY"
            ? `Comment "${parentId}" is itself a reply — threads are only one level deep. Reply to the root comment instead.`
            : `Comment body must not be empty.`
    return { content: [{ type: "text" as const, text: message }] }
  }

  const c = result.comment
  const kind = c.parentId ? "Reply added" : c.anchorText ? "Anchored comment added" : "Comment added"
  return {
    content: [
      {
        type: "text" as const,
        text:
          `**${kind}** on doc "${docId}"\n` +
          `Author: ${c.authorName} (${c.authorType})\n` +
          (c.anchorText ? `Anchored to: "${truncate(c.anchorText, 80)}"\n` : "") +
          `Body: ${truncate(c.body, 120)}\n` +
          `ID: ${c.id}`,
      },
    ],
  }
}

// ── list_doc_comments ───────────────────────────────────────────────────────

export async function listDocComments({
  docId,
  status,
}: {
  docId: string
  status?: CommentStatus
}) {
  const prisma = getPrisma()

  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { id: true, title: true } })
  if (!doc) {
    return { content: [{ type: "text" as const, text: `Doc "${docId}" not found.` }] }
  }

  const comments = await listDocCommentsCore(docId, status)
  if (comments.length === 0) {
    const scope = status ? `${status.toLowerCase()} ` : ""
    return {
      content: [{ type: "text" as const, text: `No ${scope}comments on doc "${doc.title}".` }],
    }
  }

  // Group into one-level-deep threads: roots (parentId null) with their replies.
  const roots = comments.filter((c) => c.parentId === null)
  const repliesByParent = new Map<string, typeof comments>()
  for (const c of comments) {
    if (c.parentId) {
      const arr = repliesByParent.get(c.parentId) ?? []
      arr.push(c)
      repliesByParent.set(c.parentId, arr)
    }
  }

  const blocks = roots.map((root) => {
    const anchor = root.anchorText ? ` — anchored to "${truncate(root.anchorText, 60)}"` : " — general"
    const head =
      `[${root.status}]${anchor}\n` +
      `${root.authorName} (${root.authorType}) — ${root.createdAt.toISOString()}\n` +
      `${root.body}\n` +
      `ID: ${root.id}`
    const replies = (repliesByParent.get(root.id) ?? []).map(
      (r) =>
        `  ↳ ${r.authorName} (${r.authorType}) — ${r.createdAt.toISOString()}\n` +
        `    ${r.body}\n` +
        `    ID: ${r.id}`
    )
    return [head, ...replies].join("\n")
  })

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Comments on doc "${doc.title}" (${roots.length} thread${roots.length === 1 ? "" : "s"}):\n\n` +
          blocks.join("\n\n"),
      },
    ],
  }
}

// ── get_doc_comment ─────────────────────────────────────────────────────────

export async function getDocComment({ commentId }: { commentId: string }) {
  const comment = await getDocCommentCore(commentId)
  if (!comment) {
    return { content: [{ type: "text" as const, text: `Comment "${commentId}" not found.` }] }
  }

  const lines: (string | null)[] = [
    `[${comment.status}] ${comment.parentId ? "Reply" : comment.anchorText ? "Anchored comment" : "General comment"}`,
    `Author: ${comment.authorName} (${comment.authorType})`,
    `Doc ID: ${comment.docId}`,
    comment.parentId ? `Reply to: ${comment.parentId}` : null,
    comment.anchorText ? `Anchored to: "${comment.anchorText}"` : null,
    `Created: ${comment.createdAt.toISOString()}`,
    `Updated: ${comment.updatedAt.toISOString()}`,
    "",
    comment.body,
    `ID: ${comment.id}`,
  ]

  return {
    content: [{ type: "text" as const, text: lines.filter((l): l is string => l !== null).join("\n") }],
  }
}

// ── update_doc_comment ──────────────────────────────────────────────────────

export async function updateDocComment({ commentId, body }: { commentId: string; body: string }) {
  const updated = await updateDocCommentBodyCore(commentId, body)
  if (!updated) {
    return { content: [{ type: "text" as const, text: `Comment "${commentId}" not found.` }] }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `**Comment updated**\n` + `Body: ${truncate(updated.body, 120)}\n` + `ID: ${updated.id}`,
      },
    ],
  }
}

// ── delete_doc_comment ──────────────────────────────────────────────────────
// Deleting a root deletes its replies first (no FK cascade on DSQL).

export async function deleteDocComment({ commentId }: { commentId: string }) {
  const result = await deleteDocCommentCore(commentId)
  if (!result) {
    return { content: [{ type: "text" as const, text: `Comment "${commentId}" not found.` }] }
  }
  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Comment deleted**${result.wasRoot ? ` (root — ${result.deletedReplies} repl${result.deletedReplies === 1 ? "y" : "ies"} also removed)` : ""}\n` +
          `ID: ${result.id}`,
      },
    ],
  }
}

// ── resolve_doc_comment / reopen_doc_comment ────────────────────────────────

async function setStatus(commentId: string, status: CommentStatus) {
  const updated = await setDocCommentStatusCore(commentId, status)
  if (!updated) {
    return { content: [{ type: "text" as const, text: `Comment "${commentId}" not found.` }] }
  }
  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Comment ${status === "RESOLVED" ? "resolved" : "reopened"}**\n` +
          `Status: ${updated.status}\n` +
          `ID: ${updated.id}`,
      },
    ],
  }
}

export async function resolveDocComment({ commentId }: { commentId: string }) {
  return setStatus(commentId, "RESOLVED")
}

export async function reopenDocComment({ commentId }: { commentId: string }) {
  return setStatus(commentId, "OPEN")
}
