import getPrisma from "@/lib/db"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { assignmentUpdate, validateTaskLink, validateTaskReferences, type TaskAssignee } from "@/lib/task-assignment"
import { allocateOneSeq } from "@/lib/work-item-sequence"
import { mirrorTaskLinks } from "@/lib/task-link-writes"
import type { TaskLinkRecordType, TaskPriority, TaskStatus } from "@/lib/types"

export type NewTaskInput = {
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  squadId?: string | null
  parentTaskId?: string | null
  assigneeUserId?: string | null
  assignee?: TaskAssignee
  ownerName?: string | null
  storyPoints?: number | null
  dueDate?: Date | null
  iteration?: string | null
  /** TaskLinks written in the same insert as the task, validated against this workspace first. */
  links?: Array<{ linkedType: TaskLinkRecordType; linkedId: string }>
}

/**
 * The one UI-side Task insert: reference and assignee validation, end-of-column
 * placement, work item ID allocation and the following/updates capture. The
 * caller owns authentication and workspace authorization (the Tasks page action
 * and the Doc comment flow both gate on membership first), because this runs
 * with the signed-in user as the audit actor.
 */
export async function createWorkspaceTask(workspaceId: string, data: NewTaskInput) {
  const prisma = getPrisma()
  await validateTaskReferences(workspaceId, data)
  const assignment = await assignmentUpdate(workspaceId, data)
  for (const link of data.links ?? []) await validateTaskLink(workspaceId, link.linkedType, link.linkedId)
  const status = data.status ?? "TODO"

  // Place new task at the end of its status column, same convention as
  // roadmap/actions.ts addRoadmapItem.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0

  return captureWorkspaceMutation(prisma, "task", "create", "UI", undefined, async tx => {
    const created = await tx.task.create({
      data: {
        workspaceId,
        ...(await allocateOneSeq(tx, workspaceId, "task")),
        title: data.title,
        description: data.description,
        status,
        priority: data.priority ?? "MEDIUM",
        squadId: data.squadId,
        parentTaskId: data.parentTaskId,
        ...assignment,
        ownerName: data.ownerName,
        storyPoints: data.storyPoints,
        dueDate: data.dueDate,
        iteration: data.iteration,
        sortOrder,
        ...(data.links?.length ? { links: { create: data.links.map(link => ({ linkedType: link.linkedType, linkedId: link.linkedId })) } } : {}),
      },
    })
    // The nested legacy links are mirrored in the same transaction (flagged); COMMENT links stay legacy-only.
    if (data.links?.length) await mirrorTaskLinks(tx, { workspaceId, links: data.links.map(link => ({ taskId: created.id, linkedType: link.linkedType, linkedId: link.linkedId })) })
    return created
  })
}
