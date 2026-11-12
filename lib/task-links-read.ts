/**
 * Reads of task links, all from entity_links: the nine association targets (TASK_REFERENCES) and the two origins, the Comment a task was
 * made from and the agent conversation that made it (TASK_CREATED_FROM). A link keeps the spelling callers already use (`DECISION`, not
 * the stored `REVIEW_REQUEST`).
 *
 * Reads are workspace-filtered on BOTH endpoints (lib/links/readers.ts): a link whose task or target is dangling, archived away or in
 * another workspace is absent. Rows are ordered (created_at, id).
 *
 * DEPLOY BEFORE MIGRATION. Origin links made before migration 115 ran exist only in the frozen task_links table, so every origin read
 * also takes the frozen rows (lib/legacy-link-tables.ts) and merges them by pair, entity_links winning. Once 115 has run the frozen rows
 * all have a twin and the merge drops them; the fallback goes with the table.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { readUnmovedTaskLinks, type UnmovedTaskLink } from "@/lib/legacy-link-tables"
import { readEntityLinksTaskOrigins, readEntityLinksTaskReferences } from "@/lib/links/readers"
import { taskLinkedTypeOf, taskOriginTargetType } from "@/lib/task-link-writes"

type Db = AppPrismaClient | AppTransactionClient

/** One task link as the UI and tools show it. `id` is what unlinkTask takes. */
export type TaskLinkView = {
  id: string
  taskId: string
  linkedType: string
  linkedId: string
  source: string
  createdById: string | null
  createdAt: Date
}

const byCreatedThenId = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const pairKey = (taskId: string, linkedType: string, linkedId: string) => `${taskId}:${linkedType}:${linkedId}`

type OriginLink = { id: string; taskId: string; linkedType: string; linkedId: string; source: string; createdById: string | null; createdAt: Date }

/** Origin links of one workspace's tasks or of one origin target: the entity_links rows plus the frozen rows that have no twin there yet. */
async function originLinks(
  db: Db,
  workspaceId: string,
  scope: { taskIds: readonly string[] } | { linkedType: string; linkedIds: readonly string[] },
): Promise<OriginLink[]> {
  const stored = await readEntityLinksTaskOrigins(
    db as AppTransactionClient,
    workspaceId,
    "taskIds" in scope ? { taskIds: scope.taskIds } : { target: { type: scope.linkedType, ids: [...new Set(scope.linkedIds)] } },
  )
  const out = new Map<string, OriginLink>()
  for (const link of stored) {
    out.set(pairKey(link.fromId, link.toType, link.toId), {
      id: link.id ?? "", taskId: link.fromId, linkedType: link.toType, linkedId: link.toId,
      source: link.source ?? "UI", createdById: link.createdById ?? null, createdAt: link.createdAt ?? new Date(0),
    })
  }
  const frozen: UnmovedTaskLink[] = await readUnmovedTaskLinks(db, "taskIds" in scope ? { taskIds: scope.taskIds, workspaceId } : { linkedType: scope.linkedType, linkedIds: scope.linkedIds, workspaceId })
  for (const row of frozen) if (!out.has(pairKey(row.taskId, row.linkedType, row.linkedId))) out.set(pairKey(row.taskId, row.linkedType, row.linkedId), row)
  return [...out.values()].sort(byCreatedThenId)
}

/**
 * Every link of the given tasks, grouped by task id (every task id appears, with an empty list when it has none), each list ordered by
 * creation. Tasks are grouped by workspace because a link lives in its task's workspace.
 */
export async function getTaskLinks(db: Db, tasks: readonly { id: string; workspaceId: string }[]): Promise<Map<string, TaskLinkView[]>> {
  const result = new Map<string, TaskLinkView[]>(tasks.map((task) => [task.id, []]))
  if (tasks.length === 0) return result
  const byWorkspace = new Map<string, string[]>()
  for (const task of tasks) byWorkspace.set(task.workspaceId, [...(byWorkspace.get(task.workspaceId) ?? []), task.id])
  for (const [workspaceId, taskIds] of byWorkspace) {
    for (const link of await readEntityLinksTaskReferences(db as AppTransactionClient, workspaceId, { taskIds })) {
      result.get(link.fromId)?.push({
        id: link.id ?? "", taskId: link.fromId, linkedType: taskLinkedTypeOf(link.toType), linkedId: link.toId,
        source: link.source ?? "UI", createdById: link.createdById ?? null, createdAt: link.createdAt ?? new Date(0),
      })
    }
    for (const link of await originLinks(db, workspaceId, { taskIds })) result.get(link.taskId)?.push(link)
  }
  for (const links of result.values()) links.sort(byCreatedThenId)
  return result
}

/** The ids of the tasks linked to one target, in the given workspace. Works for the associations and for the two origin kinds (COMMENT, AGENT_CONVERSATION). */
export async function getTaskIdsLinkedTo(db: Db, input: { workspaceId: string; linkedType: string; linkedId: string }): Promise<string[]> {
  if (taskOriginTargetType(input.linkedType)) {
    return [...new Set((await originLinks(db, input.workspaceId, { linkedType: input.linkedType, linkedIds: [input.linkedId] })).map((link) => link.taskId))]
  }
  const links = await readEntityLinksTaskReferences(db as AppTransactionClient, input.workspaceId, { target: { type: input.linkedType, ids: [input.linkedId] } })
  return [...new Set(links.map((link) => link.fromId))]
}

/** The legacy `linked_type` spellings these display readers serve. DECISION is a review request in entity_links. */
export type TaskLinkReadTarget = "ROADMAP_ITEM" | "DECISION"

export type LinkedTask = { id: string; title: string; status: string }
export type TaskLinkedTo = { linkedId: string; task: LinkedTask }

export type TaskLinksReadInput = {
  /** The workspaces whose tasks count. entity_links is read once per workspace (a link row lives in its task's workspace). */
  workspaceIds: readonly string[]
  linkedType: TaskLinkReadTarget
  linkedIds: readonly string[]
}

async function referencesTo(db: Db, input: TaskLinksReadInput) {
  const out: { fromId: string; toId: string }[] = []
  for (const workspaceId of new Set(input.workspaceIds)) {
    out.push(...(await readEntityLinksTaskReferences(db as AppTransactionClient, workspaceId, { target: { type: input.linkedType, ids: [...new Set(input.linkedIds)] } })))
  }
  return out
}

/** The tasks linked to the given targets, one row per link: `{ linkedId, task:{id,title,status} }`. */
export async function getTasksLinkedTo(db: Db, input: TaskLinksReadInput): Promise<TaskLinkedTo[]> {
  if (input.linkedIds.length === 0) return []
  const links = await referencesTo(db, input)
  const taskIds = [...new Set(links.map((link) => link.fromId))]
  if (taskIds.length === 0) return []
  const tasks = await db.task.findMany({ where: { id: { in: taskIds }, workspaceId: { in: [...input.workspaceIds] } }, select: { id: true, title: true, status: true } })
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return links.flatMap((link) => {
    const task = byId.get(link.fromId)
    return task ? [{ linkedId: link.toId, task: { id: task.id, title: task.title, status: task.status } }] : []
  })
}

/** The target ids of one task's links of one origin kind (COMMENT, AGENT_CONVERSATION), in creation order. Association kinds are not served here. */
export async function getOriginTargetIds(db: Db, input: { taskId: string; linkedType: string }): Promise<string[]> {
  if (!taskOriginTargetType(input.linkedType)) return []
  const task = await db.task.findUnique({ where: { id: input.taskId }, select: { workspaceId: true } })
  if (!task) return []
  return (await originLinks(db, task.workspaceId, { taskIds: [input.taskId] })).filter((link) => link.linkedType === input.linkedType).map((link) => link.linkedId)
}

/**
 * The tasks of one workspace that carry an origin link of `linkedType` to any of `linkedIds` (for example the comment a task was made
 * from), one row per link in creation order. Association kinds are not served here (see getTasksLinkedTo).
 */
export async function getTasksLinkedToOrigin(db: Db, input: { workspaceId: string; linkedType: string; linkedIds: readonly string[] }): Promise<{ linkedId: string; taskId: string }[]> {
  if (!taskOriginTargetType(input.linkedType) || input.linkedIds.length === 0) return []
  return (await originLinks(db, input.workspaceId, { linkedType: input.linkedType, linkedIds: input.linkedIds })).map((link) => ({ linkedId: link.linkedId, taskId: link.taskId }))
}

/** Just the target ids that have at least one linked task. */
export async function getLinkedTargetIds(db: Db, input: TaskLinksReadInput): Promise<Set<string>> {
  if (input.linkedIds.length === 0) return new Set()
  return new Set((await referencesTo(db, input)).map((link) => link.toId))
}
