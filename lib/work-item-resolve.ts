import {
  classifyWorkItemRef,
  displayIdFromRow,
  displayIdMismatchMessage,
  WORK_ITEM_REGISTRY,
  type WorkItemType,
} from "@/lib/work-item-ids"

/**
 * The database half of work item ID resolution (ADR "Human-readable work item IDs", section 7).
 * `classifyWorkItemRef` in lib/work-item-ids.ts decides what a string is; this turns it into a row.
 *
 * Every lookup is scoped to a workspace the caller has already been authorized for, so a display ID
 * from another workspace is "not found", exactly like a UUID from another workspace. Display IDs are
 * only unique per workspace; nothing here may be called without that scope.
 *
 *   - UUID: looked up by `id` as before, so no old link, bookmark or agent transcript breaks. The row
 *     is still read so the caller learns its display ID (for the canonical redirect).
 *   - Display ID: looked up by (workspace, prefix, number). A well-formed display ID of another type
 *     ("TASK-5" given to an opportunity page) is a `wrong_type` result with a message naming the type.
 *   - Anything else: `invalid`.
 */

type Row = { id: string; seqPrefix: string | null; seqNumber: number | null }
type Delegate = { findFirst(args: { where: object; select: { id: true; seqPrefix: true; seqNumber: true } }): Promise<Row | null> }

/** Prisma delegate per type. Typed loosely on purpose: the 14 delegates share only this one call shape. */
const DELEGATE: Record<WorkItemType, string> = {
  objective: "objective",
  keyResult: "keyResult",
  opportunity: "opportunity",
  solution: "solution",
  assumption: "assumption",
  experiment: "experiment",
  task: "task",
  roadmapItem: "roadmapItem",
  feedback: "feedbackItem",
  reviewRequest: "reviewRequest",
  doc: "doc",
  artifact: "artifact",
  researchStudy: "researchStudy",
  metric: "metricDefinition",
}

/**
 * Workspace scope for a lookup by id. Key results and assumptions only gained their own workspace_id
 * in 092 (NULL until 093), so a UUID lookup keeps scoping through the parent chain like
 * lib/entity-detail.ts's `entityScopeWhere`. A display-ID lookup uses workspace_id directly: the
 * number only exists once the row has one.
 */
function idScope(type: WorkItemType, workspaceId: string): object {
  switch (type) {
    case "keyResult":
      return { objective: { workspaceId } }
    case "assumption":
      return { solution: { workspaceId } }
    default:
      return { workspaceId }
  }
}

export type WorkItemDb = object

export type ResolvedWorkItem = {
  type: WorkItemType
  /** The row's UUID: what every other query keys on. */
  id: string
  /** `TASK-5`, or null while the row is not numbered yet. */
  displayId: string | null
  /** What a URL for this row should carry: the display ID when it has one, else the UUID. */
  canonical: string
}

export type WorkItemResolution =
  | ({ ok: true } & ResolvedWorkItem)
  | { ok: false; reason: "invalid" | "not_found" | "wrong_type"; message: string }

function delegate(db: WorkItemDb, type: WorkItemType): Delegate {
  const found = (db as Record<string, unknown>)[DELEGATE[type]]
  if (!found || typeof (found as Delegate).findFirst !== "function") throw new Error(`No Prisma delegate for work item type ${type}`)
  return found as Delegate
}

const SELECT = { id: true, seqPrefix: true, seqNumber: true } as const

function resolved(type: WorkItemType, row: Row): WorkItemResolution {
  const displayId = displayIdFromRow(type, row)
  return { ok: true, type, id: row.id, displayId, canonical: displayId ?? row.id }
}

/** Resolves `ref` (a UUID or a display ID) to a row of `type` inside `workspaceId`. */
export async function resolveWorkItem(db: WorkItemDb, workspaceId: string, type: WorkItemType, ref: string): Promise<WorkItemResolution> {
  const label = WORK_ITEM_REGISTRY[type].label
  const classified = classifyWorkItemRef(ref)
  if (classified.kind === "invalid") {
    return { ok: false, reason: "invalid", message: `"${ref}" is not a ${label} ID. Use a UUID or an ID like ${WORK_ITEM_REGISTRY[type].prefix}-12.` }
  }
  if (classified.kind === "uuid") {
    const row = await delegate(db, type).findFirst({ where: { id: classified.id, ...idScope(type, workspaceId) }, select: SELECT })
    return row ? resolved(type, row) : { ok: false, reason: "not_found", message: `${label} not found` }
  }
  const { parsed } = classified
  if (parsed.type !== type) return { ok: false, reason: "wrong_type", message: displayIdMismatchMessage(parsed) }
  const row = await delegate(db, type).findFirst({
    where: { workspaceId, seqPrefix: parsed.prefix, seqNumber: parsed.number },
    select: SELECT,
  })
  return row ? resolved(type, row) : { ok: false, reason: "not_found", message: `${label} not found` }
}

/**
 * Resolves a display ID without knowing the type (the prefix says which). A UUID cannot be resolved
 * this way, because it carries no type; callers that hold only a UUID must say what it is.
 */
export async function resolveDisplayId(db: WorkItemDb, workspaceId: string, ref: string): Promise<WorkItemResolution> {
  const classified = classifyWorkItemRef(ref)
  if (classified.kind !== "display") {
    return { ok: false, reason: "invalid", message: `"${ref}" is not a work item ID like TASK-12` }
  }
  return resolveWorkItem(db, workspaceId, classified.parsed.type, ref)
}

/** The UUID for `ref`, or null when it does not resolve. For call sites that only need the id. */
export async function resolveWorkItemId(db: WorkItemDb, workspaceId: string, type: WorkItemType, ref: string): Promise<string | null> {
  const result = await resolveWorkItem(db, workspaceId, type, ref)
  return result.ok ? result.id : null
}

/**
 * For page routes: where should `param` redirect to? Returns the canonical segment when the URL does
 * not already carry it (a UUID for a numbered row, or a differently-cased display ID), else null.
 * An un-numbered row keeps its UUID URL.
 */
export function canonicalRedirectSegment(param: string, item: ResolvedWorkItem): string | null {
  return param === item.canonical ? null : item.canonical
}
