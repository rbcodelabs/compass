/**
 * Display / listing reads of `task_links`, routed through the TASK read-mode flag (entity_links read flip, PR C).
 *
 *   off (default)  the call site's own legacy `task_links` query, passed in as a closure and run verbatim (same where / select), nothing else.
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
}

/** What shadow needs from the legacy side: the link's task and that task's workspace. Selected only in shadow, never in off. */
async function shadowLegacyRows(db: Db, input: TaskLinksReadInput): Promise<{ taskId: string; linkedId: string; task: { workspaceId: string } }[]> {
  return db.taskLink.findMany({
    where: { linkedType: input.linkedType, linkedId: { in: [...input.linkedIds] } },
    select: { taskId: true, linkedId: true, task: { select: { workspaceId: true } } },
  })
}

async function entityLinkReferences(db: Db, input: TaskLinksReadInput): Promise<ComparableLink[]> {
  const { readEntityLinksTaskReferences } = await readCompare()
  const out: ComparableLink[] = []
  for (const workspaceId of new Set(input.workspaceIds)) {
    out.push(...(await readEntityLinksTaskReferences(db as AppTransactionClient, workspaceId, { target: { type: input.linkedType, ids: [...new Set(input.linkedIds)] } })))
  }
  return out
}

async function readLinked<R>(db: Db, input: TaskLinksReadInput, withTask: boolean, legacy: () => Promise<R[]>): Promise<R[]> {
  return readByFamilyMode<R[]>("TASK", {
    legacy,
    shadowScope: async () => {
      if (input.linkedIds.length === 0) return null
      const { retainLiveEndpoints, legacyTaskReferences } = await readCompare()
      const wanted = new Set(input.workspaceIds)
      const rows = (await shadowLegacyRows(db, input)).filter((row) => wanted.has(row.task.workspaceId))
      const comparable: ComparableLink[] = []
      for (const workspaceId of wanted) {
        const inWorkspace = rows.filter((row) => row.task.workspaceId === workspaceId)
        comparable.push(...(await retainLiveEndpoints(db as AppTransactionClient, workspaceId, legacyTaskReferences(inWorkspace.map((row) => ({ taskId: row.taskId, linkedType: input.linkedType, linkedId: row.linkedId }))))))
      }
      return { legacy: comparable, readEntityLinks: () => entityLinkReferences(db, input) }
    },
    entityLinks: async () => {
      if (input.linkedIds.length === 0) return []
      const links = await entityLinkReferences(db, input)
      if (!withTask) return links.map((link) => ({ linkedId: link.toId })) as unknown as R[]
      const taskIds = [...new Set(links.map((link) => link.fromId))]
      if (taskIds.length === 0) return []
      const tasks = await db.task.findMany({ where: { id: { in: taskIds }, workspaceId: { in: [...input.workspaceIds] } }, select: { id: true, title: true, status: true } })
      const byId = new Map(tasks.map((task) => [task.id, task]))
      // Callers consume only the fields their own legacy select returned, all of which this superset carries.
      return links.flatMap((link) => {
        const task = byId.get(link.fromId)
        return task ? [{ linkedId: link.toId, task: { id: task.id, title: task.title, status: task.status } }] : []
      }) as unknown as R[]
    },
  })
}

/**
 * The tasks linked to the given targets, one row per link. `legacy` is the call site's own task_links query, verbatim: it is the whole
 * off path (and the shadow result, and the fallback when the entity_links read throws). `on` returns `{ linkedId, task:{id,title,status} }`
 * rows, a superset of every legacy select used at the routed sites.
 */
export function getTasksLinkedTo<R>(db: Db, input: TaskLinksReadInput, legacy: () => Promise<R[]>): Promise<R[]> {
  return readLinked(db, input, true, legacy)
}

/** Just the target ids that have at least one linked task. `legacy` is the call site's verbatim `select: { linkedId: true }` query. */
export async function getLinkedTargetIds(db: Db, input: TaskLinksReadInput, legacy: () => Promise<{ linkedId: string }[]>): Promise<Set<string>> {
  return new Set((await readLinked(db, input, false, legacy)).map((row) => row.linkedId))
}
