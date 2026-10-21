/**
 * Display / listing reads of `task_links`, routed through the TASK read-mode flag (entity_links read flip, PR C).
 *
 *   off (default)  the legacy `task_links` query, exactly as each call site ran it before.
 *   shadow         the legacy result is returned; the same scope is compared with entity_links TASK_REFERENCES (counts and ids only).
 *   on             entity_links serves the read; if that read throws, legacy serves it (lib/links/read-switch.ts).
 *
 * Only pure reads that feed display belong here: "which tasks are linked to these roadmap items / this decision". Reads that need the
 * legacy row id (the unlink / delete paths, the tasks page whose rows carry the id to unlink), reads that are the existence check of a
 * write (findFirst-before-create, "already has linked work" guards) and COMMENT links (legacy-only by design, never mirrored) stay on
 * `task_links` at their call sites and are commented there.
 *
 * Differences of `on` from legacy, by design (pinned in __tests__/links/task-links-read-parity.test.ts):
 *   - a link whose target is dangling / archived-away / in another workspace is absent (legacy returned the row and the caller dropped
 *     or showed a stale one);
 *   - rows are ordered (created_at, id); legacy had no ORDER BY on these reads, so no caller can depend on an order.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { readByFamilyMode } from "@/lib/links/read-switch"
import type { ComparableLink } from "@/lib/links/read-compare"

type Db = AppPrismaClient | AppTransactionClient

const readCompare = () => import("@/lib/links/read-compare")

/** The legacy `linked_type` spellings these readers serve. DECISION is a review request in entity_links. */
export type TaskLinkReadTarget = "ROADMAP_ITEM" | "DECISION"

export type LinkedTask = { id: string; title: string; status: string }
export type TaskLinkedTo = { linkedId: string; task: LinkedTask }

export type TaskLinksReadInput = {
  /** The workspaces whose tasks count. entity_links is read once per workspace (a link row lives in its task's workspace). */
  workspaceIds: readonly string[]
  linkedType: TaskLinkReadTarget
  linkedIds: readonly string[]
  /**
   * True when the call site never filtered the legacy read by the task's workspace. Off / shadow then keep that query unchanged;
   * `on` is workspace-scoped regardless (entity_links rows are).
   */
  unscopedLegacy?: boolean
}

type LegacyRow = { taskId: string; linkedId: string; task?: Partial<LinkedTask> & { workspaceId?: string } }

async function legacyRows(db: Db, input: TaskLinksReadInput, withTask: boolean): Promise<LegacyRow[]> {
  if (input.linkedIds.length === 0) return []
  return db.taskLink.findMany({
    where: {
      linkedType: input.linkedType,
      linkedId: { in: [...input.linkedIds] },
      ...(input.unscopedLegacy ? {} : { task: { workspaceId: { in: [...input.workspaceIds] } } }),
    },
    select: { taskId: true, linkedId: true, task: { select: withTask ? { id: true, title: true, status: true, workspaceId: true } : { workspaceId: true } } },
  }) as Promise<LegacyRow[]>
}

async function entityLinkReferences(db: Db, input: TaskLinksReadInput): Promise<ComparableLink[]> {
  if (input.linkedIds.length === 0) return []
  const { readEntityLinksTaskReferences } = await readCompare()
  const out: ComparableLink[] = []
  for (const workspaceId of new Set(input.workspaceIds)) {
    out.push(...(await readEntityLinksTaskReferences(db as AppTransactionClient, workspaceId, { target: { type: input.linkedType, ids: [...new Set(input.linkedIds)] } })))
  }
  return out
}

type Linked = { linkedId: string; task?: LinkedTask }

/** The shared read. `withTask` false (id-only callers) skips selecting / loading task fields on either side. */
async function readLinked(db: Db, input: TaskLinksReadInput, withTask: boolean): Promise<Linked[]> {
  let held: LegacyRow[] = [] // the legacy rows, kept for the shadow compare (each task's workspace drives the liveness filter)
  return readByFamilyMode<Linked[]>("TASK", {
    legacy: async () => {
      held = await legacyRows(db, input, withTask)
      return held.map((row) => (withTask ? { linkedId: row.linkedId, task: { id: row.task!.id!, title: row.task!.title!, status: row.task!.status! } } : { linkedId: row.linkedId }))
    },
    shadowScope: async () => {
      const { retainLiveEndpoints, legacyTaskReferences } = await readCompare()
      const wanted = new Set(input.workspaceIds)
      const workspaceOf = (row: LegacyRow) => row.task?.workspaceId ?? input.workspaceIds[0]
      const rows = held.filter((row) => wanted.has(workspaceOf(row)))
      const legacy: ComparableLink[] = []
      for (const workspaceId of wanted) {
        const inWorkspace = rows.filter((row) => workspaceOf(row) === workspaceId)
        legacy.push(...(await retainLiveEndpoints(db as AppTransactionClient, workspaceId, legacyTaskReferences(inWorkspace.map((row) => ({ taskId: row.taskId, linkedType: input.linkedType, linkedId: row.linkedId }))))))
      }
      return { legacy, readEntityLinks: () => entityLinkReferences(db, input) }
    },
    entityLinks: async () => {
      const links = await entityLinkReferences(db, input)
      if (!withTask) return links.map((link) => ({ linkedId: link.toId }))
      const taskIds = [...new Set(links.map((link) => link.fromId))]
      if (taskIds.length === 0) return []
      const tasks = await db.task.findMany({ where: { id: { in: taskIds }, workspaceId: { in: [...input.workspaceIds] } }, select: { id: true, title: true, status: true } })
      const byId = new Map(tasks.map((task) => [task.id, task]))
      return links.flatMap((link): Linked[] => {
        const task = byId.get(link.fromId)
        return task ? [{ linkedId: link.toId, task: { id: task.id, title: task.title, status: task.status } }] : []
      })
    },
  })
}

/** The tasks linked to the given targets, one row per link. Same shape as the legacy `{ linkedId, task }` select. */
export async function getTasksLinkedTo(db: Db, input: TaskLinksReadInput): Promise<TaskLinkedTo[]> {
  return (await readLinked(db, input, true)) as TaskLinkedTo[]
}

/** Just the target ids that have at least one linked task (for "has follow-up work" filters). */
export async function getLinkedTargetIds(db: Db, input: TaskLinksReadInput): Promise<Set<string>> {
  return new Set((await readLinked(db, input, false)).map((row) => row.linkedId))
}
