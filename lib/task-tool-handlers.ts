/**
 * Handler functions for the Tasks MCP tools (create_task, get_task, list_tasks,
 * update_task, move_task_status, link_task, unlink_task, list_task_links).
 * Extracted into this module so they can be unit-tested without the MCP
 * server layer, following the same shape as lib/roadmap-tool-handlers.ts.
 *
 * Task is a standalone entity; links to other Compass objects are polymorphic
 * many-to-many via TaskLink (linkedType discriminator + bare linkedId UUID,
 * no Prisma @relation — same reasoning as CustomFieldValue.objectId). Cross-
 * type reads are resolved here by grouping links by linkedType and batch-
 * fetching each target table, then stitching titles back onto the links.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types"

// Maps each TaskLinkedType to its Prisma model delegate name. Every target
// table exposes a plain `title` column, so a single resolver works for all
// eight types.
const LINK_TARGET_MODEL = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedbackItem",
} as const satisfies Record<TaskLinkedType, string>

type LinkRow = { id: string; linkedType: string; linkedId: string }

/** Batch-resolves a task's TaskLink rows to human-readable titles, grouped by linkedType. */
async function resolveLinkTitles(
  prisma: ReturnType<typeof getPrisma>,
  links: LinkRow[]
): Promise<Map<string, string>> {
  const byType = new Map<string, string[]>()
  for (const link of links) {
    const ids = byType.get(link.linkedType) ?? []
    ids.push(link.linkedId)
    byType.set(link.linkedType, ids)
  }

  const titleById = new Map<string, string>()
  for (const [linkedType, ids] of byType) {
    const modelName = LINK_TARGET_MODEL[linkedType as TaskLinkedType]
    if (!modelName) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[modelName]
    const rows: { id: string; title: string }[] = await delegate.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true },
    })
    for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title)
  }
  return titleById
}

async function formatLinks(prisma: ReturnType<typeof getPrisma>, links: LinkRow[]) {
  const titleById = await resolveLinkTitles(prisma, links)
  return links.map((l) => ({
    id: l.id,
    linkedType: l.linkedType as TaskLinkedType,
    linkedId: l.linkedId,
    linkedTitle: titleById.get(`${l.linkedType}:${l.linkedId}`) ?? "(deleted)",
  }))
}

// ─── create_task ──────────────────────────────────────────────────────────────

export async function createTask({
  workspaceId,
  title,
  description,
  status,
  priority,
  squadId,
  parentTaskId,
  assigneeUserId,
  ownerName,
  storyPoints,
  dueDate,
  iteration,
}: {
  workspaceId: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  squadId?: string
  parentTaskId?: string
  assigneeUserId?: string
  ownerName?: string
  storyPoints?: number
  dueDate?: string
  iteration?: string
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) {
    return fail(`Workspace "${workspaceId}" not found.`)
  }

  if (parentTaskId) {
    const parent = await prisma.task.findUnique({ where: { id: parentTaskId }, select: { id: true, workspaceId: true } })
    if (!parent) {
      return fail(`Parent task "${parentTaskId}" not found.`)
    }
    if (parent.workspaceId !== workspaceId) {
      return fail(`Parent task "${parentTaskId}" belongs to a different workspace.`)
    }
  }

  const resolvedStatus = status ?? "TODO"

  // Place the new task at the end of its status column, same convention as
  // roadmap/actions.ts addRoadmapItem.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status: resolvedStatus },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: title.trim(),
      description,
      status: resolvedStatus,
      priority: priority ?? "MEDIUM",
      squadId,
      parentTaskId,
      assigneeUserId,
      ownerName,
      storyPoints,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      iteration,
      sortOrder,
    },
  })

  return ok(
    `**Task created:** ${task.title}\n` +
      `Status: ${task.status}\n` +
      `Priority: ${task.priority}\n` +
      `ID: ${task.id}`,
    task,
  )
}

// ─── get_task ─────────────────────────────────────────────────────────────────

export async function getTask({ taskId }: { taskId: string }) {
  const prisma = getPrisma()

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      parentTask: { select: { id: true, title: true } },
      subtasks: { select: { id: true, title: true, status: true }, orderBy: { sortOrder: "asc" } },
      links: true,
    },
  })
  if (!task) {
    return fail(`Task "${taskId}" not found.`)
  }

  const links = await formatLinks(prisma, task.links)

  const lines = [
    `**${task.title}**`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description: ${task.description}` : null,
    task.parentTask ? `Parent: ${task.parentTask.title} (ID: ${task.parentTask.id})` : null,
    task.assigneeUserId ? `Assignee (user): ${task.assigneeUserId}` : null,
    task.ownerName ? `Owner: ${task.ownerName}` : null,
    task.storyPoints != null ? `Story points: ${task.storyPoints}` : null,
    task.dueDate ? `Due: ${task.dueDate.toISOString()}` : null,
    task.iteration ? `Iteration: ${task.iteration}` : null,
    task.squadId ? `Squad: ${task.squadId}` : null,
    "",
    task.subtasks.length
      ? `Subtasks (${task.subtasks.length}):\n` + task.subtasks.map((s) => `  • [${s.status}] ${s.title} — ID: ${s.id}`).join("\n")
      : "Subtasks: none",
    "",
    links.length
      ? `Links (${links.length}):\n` + links.map((l) => `  • [${l.linkedType}] ${l.linkedTitle} — ID: ${l.linkedId}`).join("\n")
      : "Links: none",
    "",
    `ID: ${task.id}`,
  ].filter((l) => l !== null)

  return ok(lines.join("\n"), { ...task, links })
}

// ─── list_tasks ───────────────────────────────────────────────────────────────

export async function listTasks({
  workspaceId,
  status,
  priority,
  squadId,
  assigneeUserId,
  parentTaskId,
  linkedType,
  linkedId,
  includeSubtasks,
}: {
  workspaceId: string
  status?: TaskStatus
  priority?: TaskPriority
  squadId?: string
  assigneeUserId?: string
  parentTaskId?: string | null
  linkedType?: TaskLinkedType
  linkedId?: string
  includeSubtasks?: boolean
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) {
    return fail(`Workspace "${workspaceId}" not found.`)
  }

  // parentTaskId: undefined = no filter, null = top-level only, string = children of that parent.
  const where = {
    workspaceId,
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(squadId ? { squadId } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(linkedType && linkedId ? { links: { some: { linkedType, linkedId } } } : {}),
  }

  const tasks = await prisma.task.findMany({
    where,
    include: { _count: { select: { subtasks: true } } },
    orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
  })

  if (!tasks.length) {
    return fail("No tasks found.")
  }

  if (includeSubtasks) {
    const topLevel = tasks.filter((t) => !t.parentTaskId)
    const childrenByParent = new Map<string, typeof tasks>()
    for (const t of tasks) {
      if (!t.parentTaskId) continue
      const list = childrenByParent.get(t.parentTaskId) ?? []
      list.push(t)
      childrenByParent.set(t.parentTaskId, list)
    }
    const lines = topLevel.map((t) => {
      const children = childrenByParent.get(t.id) ?? []
      const childLines = children.map((c) => `    ↳ [${c.status}] ${c.title} — ID: ${c.id}`)
      return [
        `• [${t.status}] **${t.title}** (${t.priority})\n  ID: ${t.id}`,
        ...childLines,
      ].join("\n")
    })
    return ok(lines.join("\n\n"), {
      items: topLevel.map((t) => ({
        id: t.id,
        status: t.status,
        title: t.title,
        priority: t.priority,
        subtasks: (childrenByParent.get(t.id) ?? []).map((c) => ({ id: c.id, status: c.status, title: c.title })),
      })),
      count: topLevel.length,
    })
  }

  const lines = tasks.map((t) =>
    `• [${t.status}] **${t.title}** (${t.priority})` +
    (t._count.subtasks ? ` — ${t._count.subtasks} subtask(s)` : "") +
    `\n  ID: ${t.id}`
  )
  return ok(lines.join("\n\n"), {
    items: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      title: t.title,
      priority: t.priority,
      subtaskCount: t._count.subtasks,
    })),
    count: tasks.length,
  })
}

// ─── update_task ──────────────────────────────────────────────────────────────

export async function updateTask({
  taskId,
  title,
  description,
  priority,
  squadId,
  assigneeUserId,
  ownerName,
  storyPoints,
  dueDate,
  iteration,
}: {
  taskId: string
  title?: string
  description?: string
  priority?: TaskPriority
  squadId?: string | null
  assigneeUserId?: string | null
  ownerName?: string | null
  storyPoints?: number | null
  dueDate?: string | null
  iteration?: string | null
}) {
  const prisma = getPrisma()

  const existing = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } })
  if (!existing) {
    return fail(`Task "${taskId}" not found.`)
  }

  const data: Record<string, unknown> = { updatedAt: new Date() }
  if (title !== undefined) data.title = title.trim()
  if (description !== undefined) data.description = description
  if (priority !== undefined) data.priority = priority
  if (squadId !== undefined) data.squadId = squadId
  if (assigneeUserId !== undefined) data.assigneeUserId = assigneeUserId
  if (ownerName !== undefined) data.ownerName = ownerName
  if (storyPoints !== undefined) data.storyPoints = storyPoints
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null
  if (iteration !== undefined) data.iteration = iteration

  const updated = await prisma.task.update({ where: { id: taskId }, data })

  return ok(
    `**Task updated:** ${updated.title}\n` +
      `Status: ${updated.status}\n` +
      `Priority: ${updated.priority}\n` +
      `ID: ${updated.id}`,
    updated,
  )
}

// ─── move_task_status ─────────────────────────────────────────────────────────

export async function moveTaskStatus({ taskId, status }: { taskId: string; status: TaskStatus }) {
  const prisma = getPrisma()

  const existing = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!existing) {
    return fail(`Task "${taskId}" not found.`)
  }

  // Place the task at the end of the destination status column, same
  // convention as roadmap/actions.ts moveItem.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId: existing.workspaceId, status, NOT: { id: taskId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { status, sortOrder, updatedAt: new Date() },
  })

  return ok(
    `**Status updated:** ${existing.title}\n` +
      `New status: ${updated.status}\n` +
      `ID: ${updated.id}`,
    updated,
  )
}

// ─── link_task ────────────────────────────────────────────────────────────────

export async function linkTask({
  taskId,
  linkedType,
  linkedId,
}: {
  taskId: string
  linkedType: TaskLinkedType
  linkedId: string
}) {
  const prisma = getPrisma()

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true } })
  if (!task) {
    return fail(`Task "${taskId}" not found.`)
  }

  const modelName = LINK_TARGET_MODEL[linkedType]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = (prisma as any)[modelName]
  const target = await delegate.findUnique({ where: { id: linkedId }, select: { id: true, title: true } })
  if (!target) {
    return fail(`${linkedType} "${linkedId}" not found.`)
  }

  const existingLink = await prisma.taskLink.findFirst({
    where: { taskId, linkedType, linkedId },
  })
  if (existingLink) {
    return fail(`Task "${task.title}" is already linked to ${linkedType} '${target.title}'.\nID: ${existingLink.id}`)
  }

  const link = await prisma.taskLink.create({ data: { taskId, linkedType, linkedId } })

  return ok(
    `**Linked:** ${task.title} → [${linkedType}] ${target.title}\n` +
      `ID: ${link.id}`,
    { taskId, linkedType, linkedId },
  )
}

// ─── unlink_task ──────────────────────────────────────────────────────────────

export async function unlinkTask({
  taskId,
  linkedType,
  linkedId,
}: {
  taskId: string
  linkedType: TaskLinkedType
  linkedId: string
}) {
  const prisma = getPrisma()

  const link = await prisma.taskLink.findFirst({ where: { taskId, linkedType, linkedId } })
  if (!link) {
    return fail(`No link found between task "${taskId}" and ${linkedType} "${linkedId}".`)
  }

  await prisma.taskLink.delete({ where: { id: link.id } })

  return ok(
    `Unlinked ${linkedType} "${linkedId}" from task "${taskId}".\nID: ${link.id}`,
    { taskId, linkedType, linkedId },
  )
}

// ─── list_task_links ──────────────────────────────────────────────────────────

export async function listTaskLinks({ taskId }: { taskId: string }) {
  const prisma = getPrisma()

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true } })
  if (!task) {
    return fail(`Task "${taskId}" not found.`)
  }

  const rawLinks = await prisma.taskLink.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } })
  if (!rawLinks.length) {
    return fail(`Task "${task.title}" has no links.`)
  }

  const links = await formatLinks(prisma, rawLinks)

  const byType = new Map<string, typeof links>()
  for (const l of links) {
    const list = byType.get(l.linkedType) ?? []
    list.push(l)
    byType.set(l.linkedType, list)
  }

  const lines: string[] = [`**Links for:** ${task.title}`]
  for (const [linkedType, group] of byType) {
    lines.push(`\n${linkedType}:`)
    for (const l of group) {
      lines.push(`  • ${l.linkedTitle} — ID: ${l.id} (target: ${l.linkedId})`)
    }
  }

  return ok(lines.join("\n"), {
    items: links.map((l) => ({
      id: l.id,
      linkedType: l.linkedType,
      linkedId: l.linkedId,
      linkedTitle: l.linkedTitle,
    })),
    count: links.length,
  })
}
