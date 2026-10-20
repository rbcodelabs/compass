/**
 * Batch creation of Opportunities and of Solutions under existing Opportunities.
 *
 * The single creation core behind the UI server action, the MCP tools
 * (`create_opportunity`, `add_solution`, `create_opportunities`,
 * `create_solutions`) and their REST twins, so a limit or a rule cannot drift
 * between callers. This module has no session, MCP or UI imports; callers
 * resolve the workspace and hand it in.
 *
 * Contract:
 *  - Every item runs in its own transaction and reports its own result
 *    (created / error / conflict). A bad item never blocks its neighbours and
 *    user input never throws.
 *  - `clientId` (a UUID the caller generated) becomes the row's primary key.
 *    Re-sending an item whose row already exists in THIS workspace with the same
 *    content answers `deduped: true`; any other collision answers a generic
 *    CONFLICT that does not reveal whether the id exists elsewhere.
 *  - Parents (squad, key result, Opportunity) are verified against the
 *    workspace inside the item's transaction: the database has no foreign keys.
 *    `Solution.workspaceId` is taken from the authorized workspace, never input.
 *  - Callers must be able to write: `assertWorkspaceWritable` runs first.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import {
  normalizeNewOpportunityInput,
  type NormalizedOpportunityInput,
} from "@/lib/opportunity-create"
import { OPPORTUNITY_TITLE_MAX_LENGTH } from "@/lib/opportunity-draft"
import { assertKeyResultInWorkspace, syncLegacyLink, TypedLinkError, type LinkSource } from "@/lib/typed-links"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { allocateOneSeq } from "@/lib/work-item-sequence"

/** Items per call. Agents get a quarter of the human cap. */
export const BATCH_MAX_ITEMS = { human: 100, agent: 25 } as const
export const SOLUTION_TITLE_MAX_LENGTH = OPPORTUNITY_TITLE_MAX_LENGTH
/** Characters. A text column has no limit of its own; 100 items must still fit one request. */
export const BATCH_DESCRIPTION_MAX_LENGTH = 10_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BatchCaller = keyof typeof BATCH_MAX_ITEMS

export type BatchContext = {
  /** The authorized workspace. `isReadOnly` comes from the workspace context; membership callers pass false. */
  workspace: { id: string; isReadOnly: boolean }
  caller: BatchCaller
  /** Stored in the row's `source` column and on link provenance. */
  source: LinkSource
  /** Who the workspace-update event is attributed to (see captureWorkspaceMutation). */
  mutationSource: Parameters<typeof captureWorkspaceMutation>[3]
  /** Attribution for links made alongside the row. Null for agents and unattributed callers. */
  createdById?: string | null
}

/** Wire format is tree-ready; `clientRef` (a parent created earlier in the same batch) is not supported yet. */
export type BatchParent = { id: string } | { clientRef: string }

export type OpportunityBatchItem = {
  /** Idempotency key and primary key. Generated here when omitted (then a retry cannot be deduped). */
  clientId?: string
  title: string
  description?: string | null
  customerSegment?: string | null
  status?: string
  squadId?: string | null
  /** Single-item MCP/REST callers only; the grid does not offer it. */
  linkedKeyResultId?: string | null
}

export type SolutionBatchItem = {
  clientId?: string
  parent?: BatchParent
  title: string
  description?: string | null
  /** Solutions start as IDEA; anything else is refused so creation cannot trigger roadmap sync. */
  status?: string
}

export type BatchErrorCode = "INVALID" | "PARENT_FAILED" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL"

export type BatchItemResult =
  | { clientId: string; ok: true; id: string; deduped?: true }
  | { clientId: string; ok: false; code: BatchErrorCode; error: string; field?: string }

export type BatchCreateResult = { results: BatchItemResult[] }

/** The whole request is refused (nothing written): empty, or over the caller's cap. */
export class BatchRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BatchRequestError"
  }
}

/** A failure inside an item's transaction that maps straight to its result. */
class ItemError extends Error {
  constructor(readonly code: BatchErrorCode, message: string, readonly field?: string) {
    super(message)
  }
}

/** The row already exists in this workspace; thrown to roll back before any write or update event. */
class AlreadyExists extends Error {
  constructor(readonly row: Record<string, unknown>) {
    super("exists")
  }
}

const CONFLICT_MESSAGE = "This id is already in use."

async function assertBatchAllowed(ctx: BatchContext, count: number) {
  // Imported lazily: workspace-context reaches the session and next-auth, which the MCP and REST handler graphs
  // (and their many unit tests) must not load just by importing this module. It always runs before any write.
  const { assertWorkspaceWritable } = await import("@/lib/workspace-context")
  assertWorkspaceWritable(ctx.workspace)
  if (count === 0) throw new BatchRequestError("Provide at least one item.")
  const cap = BATCH_MAX_ITEMS[ctx.caller]
  if (count > cap) throw new BatchRequestError(`Create at most ${cap} items per request. Nothing was created.`)
}

const blankToNull = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || null
}

/** Returns the item's id, or a failed result when the supplied id is malformed. */
function resolveClientId(raw: string | undefined, seen: Set<string>): { id: string } | { error: string } {
  const id = raw === undefined ? randomUUID() : raw
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return { error: "clientId must be a UUID." }
  const normalized = id.toLowerCase()
  if (seen.has(normalized)) return { error: "clientId appears more than once in this request." }
  seen.add(normalized)
  return { id: normalized }
}

const invalid = (clientId: string, error: string, field?: string): BatchItemResult => ({ clientId, ok: false, code: "INVALID", error, field })

function checkDescription(description: string | null | undefined): string | null {
  const value = blankToNull(description)
  if (value && value.length > BATCH_DESCRIPTION_MAX_LENGTH) return `Description must be ${BATCH_DESCRIPTION_MAX_LENGTH} characters or fewer.`
  return null
}

/** Maps what an item's transaction threw to its result. `existing(id)` re-reads the row scoped to the workspace. */
async function settle(
  clientId: string,
  error: unknown,
  sameContent: (row: Record<string, unknown>) => boolean,
  existing: () => Promise<Record<string, unknown> | null>,
): Promise<BatchItemResult> {
  const fromRow = (row: Record<string, unknown> | null): BatchItemResult =>
    row && sameContent(row)
      ? { clientId, ok: true, id: clientId, deduped: true }
      : { clientId, ok: false, code: "CONFLICT", error: CONFLICT_MESSAGE }
  if (error instanceof AlreadyExists) return fromRow(error.row)
  if (error instanceof ItemError) return { clientId, ok: false, code: error.code, error: error.message, field: error.field }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    // Lost a race on the primary key. Scoped re-read: a row in another workspace is just a conflict.
    return fromRow(await existing())
  }
  // P2023: a value that is not a valid uuid reached a uuid column.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2023") {
    return { clientId, ok: false, code: "INVALID", error: "An id in this item is not valid." }
  }
  console.error("[batch-create] item failed", error)
  return { clientId, ok: false, code: "INTERNAL", error: "Could not create this item. Retrying is safe." }
}

async function nextSortOrder(find: () => Promise<{ sortOrder: number } | null>) {
  const last = await find()
  return last ? last.sortOrder + 1 : 0
}

// ── Opportunities ───────────────────────────────────────────────────────────

export async function createOpportunityBatch(
  prisma: AppPrismaClient,
  ctx: BatchContext,
  items: readonly OpportunityBatchItem[],
): Promise<BatchCreateResult> {
  await assertBatchAllowed(ctx, items.length)
  const workspaceId = ctx.workspace.id
  const seen = new Set<string>()
  const lanes = new Map<string, number>()
  const results: BatchItemResult[] = []

  for (const item of items) {
    const resolved = resolveClientId(item.clientId, seen)
    if ("error" in resolved) {
      results.push(invalid(typeof item.clientId === "string" ? item.clientId : "", resolved.error, "clientId"))
      continue
    }
    const clientId = resolved.id
    const normalized = normalizeNewOpportunityInput({
      title: item.title,
      description: item.description,
      customerSegment: item.customerSegment,
      status: item.status,
      squadId: item.squadId,
      linkedKeyResultId: item.linkedKeyResultId,
    })
    const descriptionError = checkDescription(item.description)
    if (!normalized.ok) {
      results.push(invalid(clientId, normalized.error))
      continue
    }
    if (descriptionError) {
      results.push(invalid(clientId, descriptionError, "description"))
      continue
    }
    const data = normalized.data
    if (!lanes.has(data.status)) {
      lanes.set(
        data.status,
        await nextSortOrder(() =>
          prisma.opportunity.findFirst({ where: { workspaceId, status: data.status }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } }),
        ),
      )
    }
    const sortOrder = lanes.get(data.status)!
    lanes.set(data.status, sortOrder + 1)
    results.push(await createOneOpportunity(prisma, ctx, clientId, data, sortOrder))
  }
  return { results }
}

async function createOneOpportunity(
  prisma: AppPrismaClient,
  ctx: BatchContext,
  id: string,
  data: NormalizedOpportunityInput,
  sortOrder: number,
): Promise<BatchItemResult> {
  const workspaceId = ctx.workspace.id
  const sameContent = (row: Record<string, unknown>) =>
    row.title === data.title &&
    (row.description ?? null) === data.description &&
    (row.customerSegment ?? null) === data.customerSegment &&
    (row.squadId ?? null) === data.squadId
  try {
    await captureWorkspaceMutation(
      prisma,
      "opportunity",
      "create",
      ctx.mutationSource,
      undefined,
      async (tx: AppTransactionClient) => {
        // First, so a retry is still answered after the squad or key result has since gone away.
        const existing = await tx.opportunity.findFirst({ where: { id, workspaceId } })
        if (existing) throw new AlreadyExists(existing)
        if (data.squadId && !(await tx.squad.findFirst({ where: { id: data.squadId, workspaceId }, select: { id: true } }))) {
          throw new ItemError("NOT_FOUND", "That squad is not in this workspace.", "squadId")
        }
        if (data.linkedKeyResultId) {
          try {
            await assertKeyResultInWorkspace(tx, data.linkedKeyResultId, workspaceId)
          } catch (error) {
            if (error instanceof TypedLinkError) throw new ItemError("NOT_FOUND", "That key result is not in this workspace.", "linkedKeyResultId")
            throw error
          }
        }
        const created = await tx.opportunity.create({
          data: {
            id,
            ...(await allocateOneSeq(tx, workspaceId, "opportunity")),
            workspaceId,
            title: data.title,
            description: data.description,
            customerSegment: data.customerSegment,
            status: data.status,
            squadId: data.squadId,
            linkedKeyResultId: data.linkedKeyResultId,
            sortOrder,
            source: ctx.source,
          },
        })
        if (data.linkedKeyResultId) {
          await syncLegacyLink(tx, {
            opportunityId: created.id,
            workspaceId,
            keyResultId: data.linkedKeyResultId,
            ctx: { source: ctx.source, createdById: ctx.createdById ?? null },
          })
        }
        return created
      },
      { atomic: true },
    )
    return { clientId: id, ok: true, id }
  } catch (error) {
    return settle(id, error, sameContent, () => prisma.opportunity.findFirst({ where: { id, workspaceId } }))
  }
}

// ── Solutions ───────────────────────────────────────────────────────────────

type NormalizedSolution = { title: string; description: string | null; parentId: string }

/** Validation shared by every Solution creator: same caps as the UI, a trimmed non-blank title. */
export function normalizeNewSolutionInput(
  input: Pick<SolutionBatchItem, "title" | "description" | "status" | "parent">,
): { ok: true; data: NormalizedSolution } | { ok: false; error: string; field?: string } {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: "Add a title so your team can scan this at a glance.", field: "title" }
  if (title.length > SOLUTION_TITLE_MAX_LENGTH) {
    return { ok: false, error: `Title must be ${SOLUTION_TITLE_MAX_LENGTH} characters or fewer.`, field: "title" }
  }
  const descriptionError = checkDescription(input.description)
  if (descriptionError) return { ok: false, error: descriptionError, field: "description" }
  if (input.status !== undefined && input.status !== "IDEA") {
    return { ok: false, error: "Solutions start as IDEA.", field: "status" }
  }
  const parent = input.parent
  if (!parent) return { ok: false, error: "Choose the opportunity this solution belongs to.", field: "parent" }
  if ("clientRef" in parent) return { ok: false, error: "Parents created in the same request are not supported yet.", field: "parent" }
  if (typeof parent.id !== "string" || !parent.id) {
    return { ok: false, error: "Choose the opportunity this solution belongs to.", field: "parent" }
  }
  // Shape is not checked here: MCP and REST validate UUIDs at their boundary, and a malformed id simply
  // matches no row (or is mapped to INVALID in `settle`).
  return { ok: true, data: { title, description: blankToNull(input.description), parentId: parent.id } }
}

export async function createSolutionBatch(
  prisma: AppPrismaClient,
  ctx: BatchContext,
  items: readonly SolutionBatchItem[],
): Promise<BatchCreateResult> {
  await assertBatchAllowed(ctx, items.length)
  const workspaceId = ctx.workspace.id
  const seen = new Set<string>()
  const lanes = new Map<string, number>()
  const results: BatchItemResult[] = []

  for (const item of items) {
    const resolved = resolveClientId(item.clientId, seen)
    if ("error" in resolved) {
      results.push(invalid(typeof item.clientId === "string" ? item.clientId : "", resolved.error, "clientId"))
      continue
    }
    const clientId = resolved.id
    const normalized = normalizeNewSolutionInput(item)
    if (!normalized.ok) {
      results.push(invalid(clientId, normalized.error, normalized.field))
      continue
    }
    const data = normalized.data
    if (!lanes.has(data.parentId)) {
      // Scoped to the workspace, so a foreign parent id reads no sortOrder and then fails verification below.
      lanes.set(
        data.parentId,
        await nextSortOrder(() =>
          prisma.solution.findFirst({ where: { opportunityId: data.parentId, workspaceId, status: "IDEA" }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } }),
        ),
      )
    }
    const sortOrder = lanes.get(data.parentId)!
    lanes.set(data.parentId, sortOrder + 1)
    results.push(await createOneSolution(prisma, ctx, clientId, data, sortOrder))
  }
  return { results }
}

async function createOneSolution(
  prisma: AppPrismaClient,
  ctx: BatchContext,
  id: string,
  data: NormalizedSolution,
  sortOrder: number,
): Promise<BatchItemResult> {
  const workspaceId = ctx.workspace.id
  const sameContent = (row: Record<string, unknown>) =>
    row.title === data.title && (row.description ?? null) === data.description && row.opportunityId === data.parentId
  try {
    await captureWorkspaceMutation(
      prisma,
      "solution",
      "create",
      ctx.mutationSource,
      undefined,
      async (tx: AppTransactionClient) => {
        const existing = await tx.solution.findFirst({ where: { id, workspaceId } })
        if (existing) throw new AlreadyExists(existing)
        // Same answer for "missing" and "belongs to another workspace": no existence oracle.
        const parent = await tx.opportunity.findFirst({ where: { id: data.parentId, workspaceId }, select: { id: true } })
        if (!parent) throw new ItemError("NOT_FOUND", "That opportunity was not found in this workspace.", "parent")
        return tx.solution.create({
          data: {
            id,
            ...(await allocateOneSeq(tx, workspaceId, "solution")),
            workspaceId, // from the authorized workspace, never from input: the column is nullable and every reader treats NULL as deny
            opportunityId: parent.id,
            title: data.title,
            description: data.description,
            sortOrder,
            source: ctx.source,
          },
        })
      },
      { atomic: true },
    )
    return { clientId: id, ok: true, id }
  } catch (error) {
    return settle(id, error, sameContent, () => prisma.solution.findFirst({ where: { id, workspaceId } }))
  }
}
