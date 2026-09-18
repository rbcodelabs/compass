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
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { ok, fail } from "@/lib/mcp-output"
import { recencyOrderBy, type RecencySort } from "@/lib/mcp-recency"
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types"
import { assignmentUpdate, eligibleTaskAssignees, resolveTaskAssignees, taskLinkScope, validateTaskLink, validateTaskReferences, type ResolvedTaskAssignee, type TaskAssignee } from "@/lib/task-assignment"
import { getMcpActor } from "@/lib/mcp-authz"

// Maps each TaskLinkedType to its Prisma model delegate name. Every target
// table exposes a plain `title` column, so a single resolver works for all
// of them -- except DECISION (ReviewRequest), whose title lives on
// currentRevision.title. DECISION is deliberately absent from this map and
// handled by its own branch in resolveLinkTitles/linkTask below.
const LINK_TARGET_MODEL = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedbackItem",
} as const satisfies Record<Exclude<TaskLinkedType, "DECISION">, string>

type LinkRow = { id: string; linkedType: string; linkedId: string }

function assigneeText(assignee: ResolvedTaskAssignee | null) {
  return assignee ? `Assignee (${assignee.type.toLowerCase()}): ${assignee.displayName} — ${assignee.id}${assignee.available ? "" : " (unavailable)"}` : "Assignee: unassigned"
}

/** Batch-resolves a task's TaskLink rows to human-readable titles, grouped by linkedType. */
async function resolveLinkTitles(
  prisma: ReturnType<typeof getPrisma>,
  links: LinkRow[],
  workspaceId: string
): Promise<Map<string, string>> {
  const byType = new Map<string, string[]>()
  for (const link of links) {
    const ids = byType.get(link.linkedType) ?? []
    ids.push(link.linkedId)
    byType.set(link.linkedType, ids)
  }

  const titleById = new Map<string, string>()
  for (const [linkedType, ids] of byType) {
    // DECISION (ReviewRequest) has no flat `title` column -- its title lives
    // on currentRevision.title -- so it can't go through the generic
    // findMany({select: {id, title}}) path below. Handled separately.
    if (linkedType === "DECISION") {
      const rows = await prisma.reviewRequest.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, currentRevision: { select: { title: true } } },
      })
      for (const row of rows) titleById.set(`DECISION:${row.id}`, row.currentRevision?.title ?? "Untitled decision")
      continue
    }
    const modelName = LINK_TARGET_MODEL[linkedType as Exclude<TaskLinkedType, "DECISION">]
    if (!modelName) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[modelName]
    const rows: { id: string; title: string }[] = await delegate.findMany({
      where: { id: { in: ids }, ...taskLinkScope(workspaceId, linkedType) },
      select: { id: true, title: true },
    })
    for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title)
  }
  return titleById
}

async function formatLinks(prisma: ReturnType<typeof getPrisma>, links: LinkRow[], workspaceId: string) {
  const titleById = await resolveLinkTitles(prisma, links, workspaceId)
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
  assignee,
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
  assigneeUserId?: string | null
  assignee?: TaskAssignee
  ownerName?: string
  storyPoints?: number
  dueDate?: string
  iteration?: string
}) {
  const prisma = getPrisma()

  // Slugs ride along on the existence check this handler already performs, so
  // the deeplink below adds no query.
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  })
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
  let assignment
  try {
    assignment = await assignmentUpdate(workspaceId, { assignee, assigneeUserId })
    await validateTaskReferences(workspaceId, { squadId })
  } catch (error) { return fail(error instanceof Error ? error.message : "Invalid task assignment") }

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
      ...assignment,
      ownerName,
      storyPoints,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      iteration,
      sortOrder,
    },
  })

  return ok(
    withUrlLine(
      `**Task created:** ${task.title}\n` +
        `Status: ${task.status}\n` +
        `Priority: ${task.priority}\n` +
        `ID: ${task.id}`,
      safeEntityUrl({
        orgSlug: workspace.organization?.slug,
        workspaceSlug: workspace.slug,
        type: "task",
        id: task.id,
      }),
    ),
    (await resolveTaskAssignees(workspaceId, [task]))[0],
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

  const links = await formatLinks(prisma, task.links, task.workspaceId)
  const resolved = (await resolveTaskAssignees(task.workspaceId, [task]))[0]

  const lines = [
    `**${task.title}**`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description: ${task.description}` : null,
    task.parentTask ? `Parent: ${task.parentTask.title} (ID: ${task.parentTask.id})` : null,
    assigneeText(resolved.assignee),
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

  return ok(lines.join("\n"), { ...resolved, links })
}

// ─── list_tasks ───────────────────────────────────────────────────────────────

export async function listTaskAssignees({ workspaceId, search, offset = 0, limit = 50 }: { workspaceId: string; search?: string; offset?: number; limit?: number }) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("Invalid pagination: offset must be nonnegative and limit between 1 and 100")
  const options = await eligibleTaskAssignees(workspaceId)
  const matching = options.filter(option => !search || `${option.displayName} ${option.ownerName ?? ""}`.toLowerCase().includes(search.toLowerCase()))
  return ok("Available task assignees", { items: matching.slice(offset, offset + limit), count: matching.length, offset, limit })
}

export async function listTasks({
  workspaceId,
  status,
  priority,
  squadId,
  assigneeUserId,
  assignee,
  parentTaskId,
  linkedType,
  linkedId,
  includeSubtasks,
  updatedSince,
  updatedBefore,
  assignedToMe,
  sort,
}: {
  workspaceId: string
  status?: TaskStatus
  priority?: TaskPriority
  squadId?: string
  assigneeUserId?: string
  assignee?: TaskAssignee
  parentTaskId?: string | null
  linkedType?: TaskLinkedType
  linkedId?: string
  includeSubtasks?: boolean
  updatedSince?: string
  updatedBefore?: string
  assignedToMe?: boolean
  sort?: RecencySort
}) {
  const prisma = getPrisma()

  if (assignee !== undefined && assigneeUserId !== undefined) return fail("Cannot supply both assignee and assigneeUserId")
  if (assignedToMe) {
    if (assignee !== undefined || assigneeUserId !== undefined) return fail("Cannot combine assignedToMe with another assignee filter")
    const actor = getMcpActor()
    if (actor.purpose === "AGENT" && actor.agentId) assignee = { type: "AGENT", id: actor.agentId }
    else if ((!actor.purpose || actor.purpose === "USER") && actor.userId) assignee = { type: "USER", id: actor.userId }
    else return fail("Assigned to me requires a personal or registered agent identity")
  }

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
    ...(assignee !== undefined ? assignee === null ? { assigneeUserId: null, assigneeAgentId: null } : assignee.type === "AGENT" ? { assigneeAgentId: assignee.id } : { assigneeUserId: assignee.id } : assigneeUserId ? { assigneeUserId } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(linkedType && linkedId ? { links: { some: { linkedType, linkedId } } } : {}),
    ...(updatedSince || updatedBefore
      ? {
          updatedAt: {
            ...(updatedSince ? { gte: new Date(updatedSince) } : {}),
            ...(updatedBefore ? { lt: new Date(updatedBefore) } : {}),
          },
        }
      : {}),
  }

  // Applied to the subtask-backfill query below as well, so a sorted call does
  // not leave the two result sets ordered by different rules.
  const taskOrderBy = recencyOrderBy(sort) ?? [{ status: "asc" as const }, { sortOrder: "asc" as const }, { id: "asc" as const }]

  const matchingTasks = await resolveTaskAssignees(workspaceId, await prisma.task.findMany({
    where,
    include: { _count: { select: { subtasks: true } } },
    orderBy: taskOrderBy,
  }))

  if (!matchingTasks.length) {
    return fail("No tasks found.")
  }

  if (includeSubtasks) {
    const matchingIds = new Set(matchingTasks.map((task) => task.id))
    const missingParentIds = [...new Set(
      matchingTasks
        .map((task) => task.parentTaskId)
        .filter((parentId): parentId is string => typeof parentId === "string" && !matchingIds.has(parentId)),
    )].sort()
    const missingParents = missingParentIds.length
      ? await resolveTaskAssignees(workspaceId, await prisma.task.findMany({
          where: { workspaceId, id: { in: missingParentIds } },
          include: { _count: { select: { subtasks: true } } },
          orderBy: taskOrderBy,
        }))
      : []
    const tasks = [...missingParents, ...matchingTasks]
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
      const childLines = children.map((c) => `    ↳ [${c.status}] ${c.title} — ID: ${c.id}\n      ${assigneeText(c.assignee)}`)
      return [
        `• [${t.status}] **${t.title}** (${t.priority})` +
          `\n  ${assigneeText(t.assignee)}` +
          (t.updatedAt ? `\n  Updated: ${t.updatedAt.toISOString()}` : "") +
          `\n  ID: ${t.id}`,
        ...childLines,
      ].join("\n")
    })
    return ok(lines.join("\n\n"), {
      items: topLevel.map((t) => ({
        id: t.id,
        status: t.status,
        title: t.title,
        priority: t.priority,
        assignee: t.assignee,
        assigneeUserId: t.assigneeUserId,
        assigneeAgentId: t.assigneeAgentId,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        subtasks: (childrenByParent.get(t.id) ?? []).map((c) => ({
          id: c.id,
          status: c.status,
          title: c.title,
          assignee: c.assignee,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      })),
      count: topLevel.length,
    })
  }

  const lines = matchingTasks.map((t) =>
    `• [${t.status}] **${t.title}** (${t.priority})` +
    (t._count.subtasks ? ` — ${t._count.subtasks} subtask(s)` : "") +
    `\n  ${assigneeText(t.assignee)}` +
    (t.updatedAt ? `\n  Updated: ${t.updatedAt.toISOString()}` : "") +
    `\n  ID: ${t.id}`
  )
  return ok(lines.join("\n\n"), {
    items: matchingTasks.map((t) => ({
      id: t.id,
      status: t.status,
      title: t.title,
      priority: t.priority,
      assignee: t.assignee,
      assigneeUserId: t.assigneeUserId,
      assigneeAgentId: t.assigneeAgentId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      subtaskCount: t._count.subtasks,
    })),
    count: matchingTasks.length,
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
  assignee,
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
  assignee?: TaskAssignee
  ownerName?: string | null
  storyPoints?: number | null
  dueDate?: string | null
  iteration?: string | null
}) {
  const prisma = getPrisma()

  const existing = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, workspaceId: true } })
  if (!existing) {
    return fail(`Task "${taskId}" not found.`)
  }

  const data: Record<string, unknown> = { updatedAt: new Date() }
  if (title !== undefined) data.title = title.trim()
  if (description !== undefined) data.description = description
  if (priority !== undefined) data.priority = priority
  if (squadId !== undefined) data.squadId = squadId
  try {
    Object.assign(data, await assignmentUpdate(existing.workspaceId, { assignee, assigneeUserId }))
    await validateTaskReferences(existing.workspaceId, { squadId })
  } catch (error) { return fail(error instanceof Error ? error.message : "Invalid task assignment") }
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
    (await resolveTaskAssignees(existing.workspaceId, [updated]))[0],
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

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, workspaceId: true } })
  if (!task) {
    return fail(`Task "${taskId}" not found.`)
  }

  // DECISION (ReviewRequest) has no flat `title` column -- see the comment on
  // LINK_TARGET_MODEL and resolveLinkTitles above.
  let target: { id: string; title: string } | null
  if (linkedType === "DECISION") {
    const row = await prisma.reviewRequest.findUnique({ where: { id: linkedId }, select: { id: true, currentRevision: { select: { title: true } } } })
    target = row ? { id: row.id, title: row.currentRevision?.title ?? "Untitled decision" } : null
  } else {
    const modelName = LINK_TARGET_MODEL[linkedType]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[modelName]
    target = await delegate.findUnique({ where: { id: linkedId }, select: { id: true, title: true } })
  }
  if (!target) {
    return fail(`${linkedType} "${linkedId}" not found.`)
  }
  try { await validateTaskLink(task.workspaceId, linkedType, linkedId) }
  catch (error) { return fail(error instanceof Error ? error.message : "Invalid task link") }

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

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, workspaceId: true } })
  if (!task) {
    return fail(`Task "${taskId}" not found.`)
  }

  const rawLinks = await prisma.taskLink.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } })
  if (!rawLinks.length) {
    return fail(`Task "${task.title}" has no links.`)
  }

  const links = await formatLinks(prisma, rawLinks, task.workspaceId)

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
