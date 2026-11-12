/**
 * Reads of task links. The nine association targets (TASK_REFERENCES) come from entity_links; the residual kinds that are not
 * associations (COMMENT, AGENT_CONVERSATION, ...) come from task_links (see lib/task-link-writes.ts). A link keeps the spelling callers
 * already use (`DECISION`, not the stored `REVIEW_REQUEST`).
 *
 * Reference reads are workspace-filtered on BOTH endpoints (lib/links/readers.ts): a link whose task or target is dangling, archived away
 * or in another workspace is absent. Rows are ordered (created_at, id).
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { readEntityLinksTaskReferences } from "@/lib/links/readers"
import { TASK_REFERENCE_LINKED_TYPES, taskLinkedTypeOf, taskReferenceTargetType } from "@/lib/task-link-writes"

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

/**
 * Every link of the given tasks, grouped by task id (every task id appears, with an empty list when it has none), each list ordered by
 * creation. Tasks are grouped by workspace because a reference link lives in its task's workspace.
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
  }
  const residual = await db.taskLink.findMany({ where: { taskId: { in: tasks.map((task) => task.id) }, linkedType: { notIn: [...TASK_REFERENCE_LINKED_TYPES] } } })
  for (const row of residual) {
    result.get(row.taskId)?.push({ id: row.id, taskId: row.taskId, linkedType: row.linkedType, linkedId: row.linkedId, source: row.source, createdById: row.createdById, createdAt: row.createdAt })
  }
  for (const links of result.values()) links.sort(byCreatedThenId)
  return result
}

/** The ids of the tasks linked to one target, in the given workspace. Works for every kind (a COMMENT or AGENT_CONVERSATION target too). */
export async function getTaskIdsLinkedTo(db: Db, input: { workspaceId: string; linkedType: string; linkedId: string }): Promise<string[]> {
  if (!taskReferenceTargetType(input.linkedType)) {
    const rows = await db.taskLink.findMany({ where: { linkedType: input.linkedType, linkedId: input.linkedId, task: { workspaceId: input.workspaceId } }, select: { taskId: true } })
    return [...new Set(rows.map((row) => row.taskId))]
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

/** The target ids of one task's links of one residual kind (COMMENT, AGENT_CONVERSATION), in creation order. Association kinds are not served here. */
export async function getResidualTargetIds(db: Db, input: { taskId: string; linkedType: string }): Promise<string[]> {
  if (taskReferenceTargetType(input.linkedType)) return []
  const rows = await db.taskLink.findMany({ where: { taskId: input.taskId, linkedType: input.linkedType }, select: { linkedId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  return rows.map((row) => row.linkedId)
}

/**
 * The tasks of one workspace that carry a residual link of `linkedType` to any of `linkedIds` (for example the Doc comment a task was made
 * from), one row per link in creation order. Association kinds are not served here (see getTasksLinkedTo).
 */
export async function getTasksLinkedToResidual(db: Db, input: { workspaceId: string; linkedType: string; linkedIds: readonly string[] }): Promise<{ linkedId: string; taskId: string }[]> {
  if (taskReferenceTargetType(input.linkedType) || input.linkedIds.length === 0) return []
  return db.taskLink.findMany({
    where: { linkedType: input.linkedType, linkedId: { in: [...input.linkedIds] }, task: { workspaceId: input.workspaceId } },
    select: { linkedId: true, taskId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
}

/** Just the target ids that have at least one linked task. */
export async function getLinkedTargetIds(db: Db, input: TaskLinksReadInput): Promise<Set<string>> {
  if (input.linkedIds.length === 0) return new Set()
  return new Set((await referencesTo(db, input)).map((link) => link.toId))
}
