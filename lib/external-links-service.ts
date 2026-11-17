// External links service (ADR-0028). The single read/write module for the external_links table: only this file names the
// ExternalLink model, so the invariants live in one reviewed place.
//
//  - TENANT SAFETY. The subject (a Solution or Task) is re-read with a workspace filter inside the same transaction before any
//    write, and every read and delete filters by workspaceId, so a caller who can reach two workspaces cannot cross them.
//  - NO ON CONFLICT. Writes are read-then-write in a transaction; a lost race on the unique index surfaces as a unique violation
//    and runTypedLinkTransaction re-runs the whole transaction, after which the read sees the winner and the call is a no-op.
//  - NO TRIGGERS. updatedAt is set explicitly.
//  - BOUNDED. At most MAX_EXTERNAL_LINKS_PER_SUBJECT links per subject, and workspace teardown deletes in passes of at most
//    LINK_WRITE_CHUNK rows (the DSQL transaction row cap).
//  - NOTHING FETCHES. This module never calls the URL. Live status (phase 2) is a separate, gated read.
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import {
  isExternalLinkRelation,
  isExternalLinkSubjectType,
  parseExternalLink,
  EXTERNAL_LINK_MAX_TITLE_LENGTH,
  type ExternalLinkProvider,
  type ExternalLinkRelation,
  type ExternalLinkSubjectType,
} from "@/lib/external-links"
import { LINK_WRITE_CHUNK, drainByIds, runTypedLinkTransaction } from "@/lib/typed-links"

type Tx = AppTransactionClient

export const MAX_EXTERNAL_LINKS_PER_SUBJECT = 50

export type ExternalLinkSource = "UI" | "AGENT" | "MCP" | "API" | "SYNC"

export type ExternalLinkErrorCode = "INVALID_URL" | "INVALID_INPUT" | "NOT_FOUND" | "TOO_MANY"

// A failure whose message is safe to show the caller as-is. It never confirms that a row in another workspace exists.
export class ExternalLinkError extends Error {
  constructor(
    message: string,
    readonly code: ExternalLinkErrorCode,
  ) {
    super(message)
    this.name = "ExternalLinkError"
  }
}

export type ExternalLinkRecord = {
  id: string
  workspaceId: string
  subjectType: ExternalLinkSubjectType
  subjectId: string
  provider: ExternalLinkProvider
  url: string
  externalKey: string
  title: string
  relation: ExternalLinkRelation
  source: string
  createdById: string | null
  createdAt: Date
}

const SELECT = {
  id: true,
  workspaceId: true,
  subjectType: true,
  subjectId: true,
  provider: true,
  url: true,
  externalKey: true,
  title: true,
  relation: true,
  source: true,
  createdById: true,
  createdAt: true,
} as const

function toRecord(row: Record<string, unknown>): ExternalLinkRecord {
  return row as unknown as ExternalLinkRecord
}

// The subject must exist in THIS workspace. A NULL workspace (legacy Solution rows) fails closed, like every other link.
async function assertSubject(tx: Tx, workspaceId: string, subjectType: ExternalLinkSubjectType, subjectId: string): Promise<void> {
  const row =
    subjectType === "SOLUTION"
      ? await tx.solution.findFirst({ where: { id: subjectId, workspaceId }, select: { id: true } })
      : await tx.task.findFirst({ where: { id: subjectId, workspaceId }, select: { id: true } })
  if (!row) throw new ExternalLinkError("That item was not found in this workspace.", "NOT_FOUND")
}

// The workspace a Solution or Task belongs to, or null when it does not exist (or has no workspace, which fails closed).
export async function getSubjectWorkspace(prisma: AppPrismaClient | Tx, subjectType: ExternalLinkSubjectType, subjectId: string): Promise<string | null> {
  const row =
    subjectType === "SOLUTION"
      ? await prisma.solution.findFirst({ where: { id: subjectId }, select: { workspaceId: true } })
      : await prisma.task.findFirst({ where: { id: subjectId }, select: { workspaceId: true } })
  return row?.workspaceId ?? null
}

export type AddExternalLinkInput = {
  workspaceId: string
  subjectType: string
  subjectId: string
  url: string
  relation?: string | null
  title?: string | null
  source?: ExternalLinkSource
  createdById?: string | null
}

export type AddExternalLinkResult = { link: ExternalLinkRecord; created: boolean }

// Adds a link, or returns the one already there (idempotent per subject + provider + external key).
export async function addExternalLink(prisma: AppPrismaClient, input: AddExternalLinkInput): Promise<AddExternalLinkResult> {
  if (!isExternalLinkSubjectType(input.subjectType)) throw new ExternalLinkError("External links can be added to a Solution or a Task.", "INVALID_INPUT")
  const subjectType = input.subjectType
  const parsed = parseExternalLink(input.url)
  if (!parsed) throw new ExternalLinkError("Enter a full https:// link, without a login or port.", "INVALID_URL")
  if (input.relation && !isExternalLinkRelation(input.relation)) throw new ExternalLinkError("Unknown relation.", "INVALID_INPUT")
  const relation: ExternalLinkRelation = input.relation && isExternalLinkRelation(input.relation) ? input.relation : parsed.defaultRelation
  const title = (input.title ?? "").trim().slice(0, EXTERNAL_LINK_MAX_TITLE_LENGTH) || parsed.title

  return runTypedLinkTransaction(prisma, async function (tx) {
    await assertSubject(tx, input.workspaceId, subjectType, input.subjectId)
    const where = { subjectType, subjectId: input.subjectId, provider: parsed.provider, externalKey: parsed.externalKey }
    const existing = await tx.externalLink.findFirst({ where: { workspaceId: input.workspaceId, ...where }, select: SELECT })
    if (existing) return { link: toRecord(existing), created: false }

    const count = await tx.externalLink.count({ where: { workspaceId: input.workspaceId, subjectType, subjectId: input.subjectId } })
    if (count >= MAX_EXTERNAL_LINKS_PER_SUBJECT) {
      throw new ExternalLinkError("This item already has the maximum of " + MAX_EXTERNAL_LINKS_PER_SUBJECT + " external links.", "TOO_MANY")
    }
    const now = new Date()
    const created = await tx.externalLink.create({
      data: {
        workspaceId: input.workspaceId,
        ...where,
        url: parsed.url,
        title,
        relation,
        source: input.source ?? "UI",
        createdById: input.createdById ?? null,
        createdAt: now,
        updatedAt: now,
      },
      select: SELECT,
    })
    return { link: toRecord(created), created: true }
  })
}

// Every external link on one subject, oldest first.
export async function listExternalLinks(
  prisma: AppPrismaClient | Tx,
  workspaceId: string,
  subjectType: ExternalLinkSubjectType,
  subjectId: string,
): Promise<ExternalLinkRecord[]> {
  const rows = await prisma.externalLink.findMany({
    where: { workspaceId, subjectType, subjectId },
    orderBy: { createdAt: "asc" },
    take: MAX_EXTERNAL_LINKS_PER_SUBJECT,
    select: SELECT,
  })
  return rows.map(toRecord)
}

// Reverse lookup: which Solutions and Tasks point at this PR, issue or file? Capped, newest first.
export async function findSubjectsByExternalKey(
  prisma: AppPrismaClient | Tx,
  workspaceId: string,
  provider: ExternalLinkProvider,
  externalKey: string,
): Promise<ExternalLinkRecord[]> {
  const rows = await prisma.externalLink.findMany({
    where: { workspaceId, provider, externalKey },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: SELECT,
  })
  return rows.map(toRecord)
}

// Where a link lives, for authorization gates: the workspace and the Solution or Task it hangs off. Null when it does not exist.
export async function getExternalLinkSubject(
  prisma: AppPrismaClient | Tx,
  linkId: string,
): Promise<{ workspaceId: string; subjectType: ExternalLinkSubjectType; subjectId: string } | null> {
  const row = await prisma.externalLink.findFirst({ where: { id: linkId }, select: { workspaceId: true, subjectType: true, subjectId: true } })
  if (!row || !isExternalLinkSubjectType(row.subjectType)) return null
  return { workspaceId: row.workspaceId, subjectType: row.subjectType, subjectId: row.subjectId }
}

// Removes one link by id. Returns how many rows went (0 when it is not in this workspace, so a stranger id leaks nothing).
export async function removeExternalLink(prisma: AppPrismaClient | Tx, workspaceId: string, linkId: string): Promise<number> {
  const result = await prisma.externalLink.deleteMany({ where: { id: linkId, workspaceId } })
  return result.count
}

// Workspace teardown: every external link in the workspace, in passes of at most LINK_WRITE_CHUNK rows.
export async function deleteWorkspaceExternalLinks(prisma: AppPrismaClient | Tx, workspaceId: string): Promise<number> {
  return drainByIds(
    function (take) {
      return prisma.externalLink.findMany({ where: { workspaceId }, select: { id: true }, take })
    },
    async function (ids) {
      return (await prisma.externalLink.deleteMany({ where: { id: { in: ids } } })).count
    },
  )
}

export { LINK_WRITE_CHUNK }
