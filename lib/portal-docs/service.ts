import type { AppPrismaClient } from "@/lib/db"
import { isMissingColumnError } from "@/lib/db-missing-column"
import { uuidLike } from "@/lib/portal-home/fields"
import type { PublicDoc, PublicDocSummary } from "./types"

export type { PublicDoc, PublicDocSummary } from "./types"

/**
 * Doc publishing for the customer portal.
 *
 * THE public predicate lives in publishedDocWhere: every public read starts from it, so "may a customer read
 * this doc" is defined once. It requires the workspace match AND publishedAt set. Docs are hard-deleted (there
 * is no archived state), so a deleted doc is simply absent. Docs whose body lives in external storage
 * (storageProvider GEODE) are excluded fail-closed: their body is not in `content` and hydrating it is not a
 * public-path concern in v1.
 */
export function publishedDocWhere(workspaceId: string) {
  return { ...publishableDocWhere(workspaceId), publishedAt: { not: null } }
}

/** Docs that CAN be published (published or not): the admin picker lists only these. Not a public read. */
export function publishableDocWhere(workspaceId: string) {
  return {
    workspaceId,
    // A canvas doc's content is canvas JSON, not markdown: never publishable. docs.doc_type is NULLABLE in the
    // database (migration 025 added it with no default; raw-SQL inserts such as the preview sample seed leave it
    // NULL), and `doc_type <> 'CANVAS'` is NULL, not true, for those rows. Match NULL explicitly so "not a canvas"
    // is the same set getDocPublishState/setDocPublished accept; a bare `docType: { not: "CANVAS" }` made a
    // publish return 200 while the customer URL 404'd.
    AND: [
      { OR: [{ docType: { not: "CANVAS" } }, { docType: null }] },
      { OR: [{ storageProvider: null }, { storageProvider: { not: "GEODE" } }] },
    ],
  }
}

/** Explicit allow-list: a column added to Doc later cannot reach the portal by accident. */
const SUMMARY_SELECT = { id: true, title: true, content: true, updatedAt: true, publishedAt: true } as const

const EXCERPT_LENGTH = 180

/** First readable text of a markdown body: headings/fences/links/emphasis stripped, whitespace collapsed. */
export function excerptOf(markdown: string | null): string {
  if (!markdown) return ""
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > EXCERPT_LENGTH ? `${plain.slice(0, EXCERPT_LENGTH).trimEnd()}…` : plain
}

type Row = { id: string; title: string; content: string | null; updatedAt: Date; publishedAt: Date | null }

function toSummary(row: Row): PublicDocSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: excerptOf(row.content),
    updatedAt: row.updatedAt.toISOString(),
    // The predicate guarantees it; the fallback only exists to keep the type honest.
    publishedAt: (row.publishedAt ?? row.updatedAt).toISOString(),
  }
}

export const MAX_PUBLISHED_DOC_LIST = 100

/**
 * Public list: published docs of ONE workspace, newest publish first. `ids` narrows to specific docs and
 * returns them in the given order (ids that are unpublished, deleted or from another workspace drop out).
 */
export async function listPublishedDocs(
  prisma: AppPrismaClient,
  workspaceId: string,
  options: { limit?: number; ids?: readonly string[] } = {},
): Promise<PublicDocSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? MAX_PUBLISHED_DOC_LIST, 1), MAX_PUBLISHED_DOC_LIST)
  const ids = options.ids ? [...new Set(options.ids)].filter((id) => uuidLike.safeParse(id).success) : undefined
  if (ids && ids.length === 0) return []
  let rows
  try {
    rows = await prisma.doc.findMany({
      where: { ...publishedDocWhere(workspaceId), ...(ids ? { id: { in: ids } } : {}) },
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      take: ids ? ids.length : limit,
      select: SUMMARY_SELECT,
    })
  } catch (error) {
    // Migration 113 not applied yet: no doc can be published, so nothing is public. Fail closed, not loud.
    if (isMissingColumnError(error)) return []
    throw error
  }
  if (!ids) return rows.map(toSummary)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is Row => !!row)
    .slice(0, limit)
    .map(toSummary)
}

/** Public read of one doc. null (never a throw) for unpublished, deleted, malformed-id or cross-workspace docs. */
export async function getPublishedDoc(prisma: AppPrismaClient, workspaceId: string, docId: string): Promise<PublicDoc | null> {
  if (!uuidLike.safeParse(docId).success) return null
  let row
  try {
    row = await prisma.doc.findFirst({ where: { ...publishedDocWhere(workspaceId), id: docId }, select: SUMMARY_SELECT })
  } catch (error) {
    if (isMissingColumnError(error)) return null
    throw error
  }
  if (!row) return null
  return { ...toSummary(row), body: row.content ?? "" }
}

/**
 * Team-side read for the editor's Publish control: is this doc published, and can it be? Returns published
 * state only to callers that already passed workspace access (the docs page). Tolerates an unapplied migration
 * 113 (nothing is published then). `publishable` mirrors the rules setDocPublished and the public predicate enforce.
 */
export async function getDocPublishState(
  prisma: AppPrismaClient,
  workspaceId: string,
  docId: string,
): Promise<{ publishedAt: string | null; publishable: boolean }> {
  try {
    const row = await prisma.doc.findFirst({ where: { id: docId, workspaceId }, select: { publishedAt: true, storageProvider: true, docType: true } })
    if (!row) return { publishedAt: null, publishable: false }
    return { publishedAt: row.publishedAt?.toISOString() ?? null, publishable: row.storageProvider !== "GEODE" && row.docType !== "CANVAS" }
  } catch (error) {
    if (isMissingColumnError(error)) return { publishedAt: null, publishable: false }
    throw error
  }
}

export interface SetDocPublishedResult {
  docId: string
  workspaceId: string
  published: boolean
  publishedAt: string | null
}

/**
 * Publish or unpublish a doc. Authorization: `userId` must be a member of the doc's workspace, the same bar as
 * editing a doc (requireWorkspaceMember in the docs actions). A non-member, a missing doc and a malformed id all
 * get the same not_found error ("Workspace not found") so a doc id never reveals its existence across workspaces.
 *
 * Unpublish is immediate: publishedAt is cleared in the same write and every public read re-queries it.
 * Publishing an already-published doc keeps its original publishedAt (idempotent).
 */
export async function setDocPublished(
  prisma: AppPrismaClient,
  input: { userId: string; docId: string; published: boolean },
): Promise<SetDocPublishedResult> {
  if (!input.userId) throw new DocPublishError("Unauthorized", "unauthorized")
  const notFound = new DocPublishError("Workspace not found", "not_found")
  if (!uuidLike.safeParse(input.docId).success) throw notFound
  const doc = await prisma.doc.findUnique({
    where: { id: input.docId },
    select: { id: true, workspaceId: true, storageProvider: true, docType: true, publishedAt: true },
  })
  if (!doc) throw notFound
  const member = await prisma.workspace.findFirst({
    where: { id: doc.workspaceId, members: { some: { userId: input.userId } } },
    select: { id: true },
  })
  if (!member) throw notFound

  if (!input.published) {
    if (doc.publishedAt !== null) {
      await prisma.doc.updateMany({
        where: { id: doc.id, workspaceId: doc.workspaceId },
        data: { publishedAt: null, publishedById: null },
      })
    }
    return { docId: doc.id, workspaceId: doc.workspaceId, published: false, publishedAt: null }
  }

  if (doc.docType === "CANVAS") throw new DocPublishError("Canvas docs cannot be published to the portal.", "unsupported")
  if (doc.storageProvider === "GEODE") throw new DocPublishError("This doc's content is stored externally and cannot be published yet.", "unsupported")
  if (doc.publishedAt !== null) {
    return { docId: doc.id, workspaceId: doc.workspaceId, published: true, publishedAt: doc.publishedAt.toISOString() }
  }
  const publishedAt = new Date()
  await prisma.doc.updateMany({
    where: { id: doc.id, workspaceId: doc.workspaceId },
    data: { publishedAt, publishedById: input.userId },
  })
  return { docId: doc.id, workspaceId: doc.workspaceId, published: true, publishedAt: publishedAt.toISOString() }
}

/**
 * A publish request that cannot proceed. Kept free of lib/permissions (and so of the auth stack) so the portal
 * resolvers that import this module stay light. `code` maps to HTTP: unauthorized 401, not_found 404, unsupported 409.
 */
export type DocPublishErrorCode = "unauthorized" | "not_found" | "unsupported"
export class DocPublishError extends Error {
  constructor(message: string, readonly code: DocPublishErrorCode) {
    super(message)
    this.name = "DocPublishError"
  }
}
