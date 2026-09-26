/**
 * Handler functions for the path-addressed Docs MCP tools (ADR 0019 —
 * Docs as a Virtual Filesystem): write_doc, delete_doc, move_doc,
 * list_doc_history, restore_doc_version, add_doc_comment, list_doc_comments,
 * resolve_doc_comment.
 *
 * These supersede the old docId-addressed tools (list_docs, get_doc,
 * create_doc, update_doc, create_doc_version, list_doc_versions,
 * get_doc_version, and the old-signature comment/restore tools), which are
 * removed outright — see docs/design/docs-virtual-filesystem-mcp.md §3.2 for
 * the full mapping. Content/structure operations go through lib/doc-fs.ts;
 * version history, restore, and comments are read/write symmetric wrappers
 * around the existing docId-addressed core logic (lib/doc-versions.ts,
 * lib/doc-comments.ts) — resolving a path to a docId is the only new step.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { documentMcpActor } from "@/lib/document-mcp-actor"
import * as docFs from "@/lib/doc-fs"
import { DocumentError } from "@/lib/document-service"
import { restoreDocVersionCore } from "@/lib/doc-versions"
import { relativeTime } from "@/lib/relative-time"
import {
  addDocComment as addDocCommentById,
  listDocComments as listDocCommentsById,
  resolveDocComment as resolveDocCommentById,
  reopenDocComment as reopenDocCommentById,
} from "@/lib/doc-comment-tool-handlers"

/** Human-readable message for the handful of doc-fs/document-service error codes an agent can hit. */
function describeError(error: unknown, path: string): string {
  if (error instanceof docFs.DocFsError) {
    switch (error.code) {
      case "not-found":
        return `No doc found at path "${path}".`
      case "has-children":
        return error.message
      case "invalid-path":
      case "invalid-move":
        return error.message
      default:
        return error.message
    }
  }
  if (error instanceof DocumentError) {
    if (error.code === "revision-conflict") {
      return `Doc at "${path}" was changed by someone else since you last read it. Read it again to get the current revision before retrying.`
    }
    if (error.code === "not-found") return `No doc found at path "${path}".`
    if (error.code === "parent-not-found" || error.code === "roadmap-item-not-found") return error.message
  }
  throw error
}

async function resolveWorkspaceUrl(workspaceId: string, docId: string): Promise<string | null> {
  const workspace = await getPrisma().workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true, organization: { select: { slug: true } } },
  })
  return safeEntityUrl({ orgSlug: workspace?.organization?.slug, workspaceSlug: workspace?.slug, type: "doc", id: docId })
}

// ── write_doc ────────────────────────────────────────────────────────────────

export async function writeDoc({
  workspaceId,
  path,
  content,
  operationId,
  expectedRevision,
}: {
  workspaceId: string
  path: string
  content: string
  operationId?: string
  expectedRevision?: string
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) return fail(`No workspace found with id "${workspaceId}".`)

  let result: Awaited<ReturnType<typeof docFs.writePath>>
  try {
    result = await docFs.writePath(workspaceId, path, content, {
      operationId,
      expectedRevision,
      ...documentMcpActor(),
    })
  } catch (error) {
    return fail(describeError(error, path))
  }

  const url = await resolveWorkspaceUrl(workspaceId, result.docId)
  const summary = `**Doc ${result.created ? "created" : "updated"}**\nID: ${result.docId}\nPath: ${result.path}`
  return ok(withUrlLine(summary, url), {
    id: result.docId,
    path: result.path,
    created: result.created,
    revision: result.revision,
    url,
  })
}

// ── delete_doc ───────────────────────────────────────────────────────────────

export async function deleteDoc({
  workspaceId,
  path,
  recursive,
  operationId,
  expectedRevision,
}: {
  workspaceId: string
  path: string
  recursive?: boolean
  operationId?: string
  expectedRevision?: string
}) {
  const node = await docFs.resolvePath(workspaceId, path)
  if (!node) return fail(`No doc found at path "${path}".`)
  try {
    await docFs.deletePath(workspaceId, path, {
      recursive,
      operationId,
      expectedRevision,
      ...documentMcpActor(),
    })
  } catch (error) {
    return fail(describeError(error, path))
  }
  return ok(`**Doc deleted**\nID: ${node.docId}\nPath: ${path}`, { id: node.docId, path, deleted: true })
}

// ── move_doc ─────────────────────────────────────────────────────────────────

export async function moveDoc({
  workspaceId,
  fromPath,
  toPath,
  operationId,
  expectedRevision,
}: {
  workspaceId: string
  fromPath: string
  toPath: string
  operationId?: string
  expectedRevision?: string
}) {
  let result: Awaited<ReturnType<typeof docFs.movePath>>
  try {
    result = await docFs.movePath(workspaceId, fromPath, toPath, {
      operationId,
      expectedRevision,
      ...documentMcpActor(),
    })
  } catch (error) {
    return fail(describeError(error, fromPath))
  }
  const url = await resolveWorkspaceUrl(workspaceId, result.docId)
  return ok(
    withUrlLine(`**Doc moved**\nID: ${result.docId}\nFrom: ${fromPath}\nTo: ${toPath}`, url),
    { id: result.docId, path: toPath, revision: result.revision, url }
  )
}

// ── list_doc_history ─────────────────────────────────────────────────────────
// Path-addressed successor to list_doc_versions. Same response shape.

export async function listDocHistory({ workspaceId, path }: { workspaceId: string; path: string }) {
  const node = await docFs.resolvePath(workspaceId, path)
  if (!node) return fail(`No doc found at path "${path}".`)

  const prisma = getPrisma()
  const versions = await prisma.docVersion.findMany({
    where: { docId: node.docId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, createdByName: true, createdAt: true },
  })

  const header = `**Version history for "${path}"**\nCurrent — last updated ${node.updatedAt.toISOString()} (${relativeTime(node.updatedAt)})`
  if (versions.length === 0) {
    return fail(`${header}\n\nNo saved versions yet.`)
  }
  const entries = versions.map(
    (v) =>
      `${v.label ? `[${v.label}] ` : ""}${v.createdByName ?? "Unknown"} — ${v.createdAt.toISOString()} (${relativeTime(v.createdAt)})\n` +
      `ID: ${v.id}`
  )
  return ok(
    `${header}\n\n${versions.length} saved version${versions.length === 1 ? "" : "s"}:\n\n${entries.join("\n\n")}`,
    {
      items: versions.map((v) => ({ id: v.id, label: v.label, authorName: v.createdByName, createdAt: v.createdAt })),
      count: versions.length,
    }
  )
}

// ── restore_doc_version ──────────────────────────────────────────────────────
// Path-addressed successor to restore_doc_version. versionId must belong to
// the doc currently at `path` -- a stale path pointing at a different doc's
// version is refused rather than silently restoring the wrong document.

export async function restoreDocVersion({
  workspaceId,
  path,
  versionId,
  expectedRevision,
  operationId,
}: {
  workspaceId: string
  path: string
  versionId: string
  expectedRevision?: string
  operationId?: string
}) {
  const node = await docFs.resolvePath(workspaceId, path)
  if (!node) return fail(`No doc found at path "${path}".`)

  const prisma = getPrisma()
  const version = await prisma.docVersion.findUnique({ where: { id: versionId }, select: { docId: true } })
  if (!version || version.docId !== node.docId) {
    return fail(`Version "${versionId}" does not belong to the doc at "${path}".`)
  }

  const doc = await prisma.doc.findUnique({ where: { id: node.docId }, select: { storageProvider: true } })
  const { restoreDocument } = await import("@/lib/document-service")
  const restored = doc?.storageProvider === "GEODE"
    ? await restoreDocument(versionId, { ...documentMcpActor(), expectedRevision, operationId })
    : await restoreDocVersionCore(versionId, { authorName: "MCP Agent" })
  if (!restored) return fail(`Version "${versionId}" not found.`)

  return ok(
    `**Doc restored** to version from ${restored.restoredFrom.toISOString()}\nPath: ${path}\nID: ${restored.id}`,
    { id: restored.id, path, restoredFrom: restored.restoredFrom }
  )
}

// ── add_doc_comment / list_doc_comments / resolve_doc_comment ───────────────
// Path-addressed successors. get_doc_comment, update_doc_comment,
// delete_doc_comment and reopen_doc_comment are removed outright (spec §3.2):
// list_doc_comments already returns full bodies, deletion is a step backward
// on an already-smaller surface, and reopen is folded into resolve's
// `resolved: false`.

async function resolveDocIdForPath(workspaceId: string, path: string): Promise<string | null> {
  const node = await docFs.resolvePath(workspaceId, path)
  return node?.docId ?? null
}

export async function addDocComment({
  workspaceId,
  path,
  body,
  authorName,
  parentId,
  anchorText,
  anchorPrefix,
  anchorSuffix,
  anchorStart,
  anchorEnd,
}: {
  workspaceId: string
  path: string
  body: string
  authorName: string
  parentId?: string
  anchorText?: string
  anchorPrefix?: string
  anchorSuffix?: string
  anchorStart?: number
  anchorEnd?: number
}) {
  const docId = await resolveDocIdForPath(workspaceId, path)
  if (!docId) return fail(`No doc found at path "${path}".`)
  return addDocCommentById({ docId, body, authorName, parentId, anchorText, anchorPrefix, anchorSuffix, anchorStart, anchorEnd })
}

export async function listDocComments({
  workspaceId,
  path,
  status,
}: {
  workspaceId: string
  path: string
  status?: "OPEN" | "RESOLVED"
}) {
  const docId = await resolveDocIdForPath(workspaceId, path)
  if (!docId) return fail(`No doc found at path "${path}".`)
  return listDocCommentsById({ docId, status })
}

export async function resolveDocComment({
  workspaceId,
  path,
  commentId,
  resolved,
}: {
  workspaceId: string
  path: string
  commentId: string
  resolved?: boolean
}) {
  const docId = await resolveDocIdForPath(workspaceId, path)
  if (!docId) return fail(`No doc found at path "${path}".`)
  const prisma = getPrisma()
  const comment = await prisma.docComment.findUnique({ where: { id: commentId }, select: { docId: true } })
  if (!comment || comment.docId !== docId) return fail(`Comment "${commentId}" does not belong to the doc at "${path}".`)
  return resolved === false ? reopenDocCommentById({ commentId }) : resolveDocCommentById({ commentId })
}
