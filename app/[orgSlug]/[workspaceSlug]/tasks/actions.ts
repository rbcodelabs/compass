"use server";

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { assertWorkspaceWritable } from "@/lib/workspace-context";
import { assignmentUpdate, resolveTaskAssignees, validateTaskLink, validateTaskReferences, type AssignmentInput, type TaskAssignee } from "@/lib/task-assignment";
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types";
import { allocateOneSeq } from "@/lib/work-item-sequence"
import { createWorkspaceTask } from "@/lib/task-create"
import { createTaskLink, deleteTaskLink, mirrorTaskLinks, upsertTaskLink } from "@/lib/task-link-writes"
import { startRunForAssignedTask, type AgentRunOutcome } from "@/lib/agent-task-trigger"

/** Only an outcome worth telling the person about; "skipped" (not an agent, nothing changed) is dropped. */
function reportableRun(outcome: AgentRunOutcome): { agentRun?: AgentRunOutcome } {
  return outcome.status === "skipped" ? {} : { agentRun: outcome };
}

async function requireTaskWorkspace(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const membership = await getPrisma().workspaceMember.findFirst({ where: { workspaceId, userId: session.user.id }, select: { id: true } });
  if (!membership) throw new Error("Not found");
  return session.user.id;
}

async function requireTask(taskId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const task = await getPrisma().task.findUnique({ where: { id: taskId }, select: { workspaceId: true, status: true, assigneeAgentId: true } });
  if (!task) throw new Error("Not found");
  await requireTaskWorkspace(task.workspaceId);
  return { ...task, userId: session.user.id };
}

// ─── Add Task ─────────────────────────────────────────────────────────────────

export async function addTask(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    squadId?: string | null;
    parentTaskId?: string | null;
    assigneeUserId?: string | null;
    assignee?: TaskAssignee;
    ownerName?: string | null;
    storyPoints?: number | null;
    dueDate?: Date | null;
    iteration?: string | null;
  },
  revalidatePathStr: string
) {
  const userId = await requireTaskWorkspace(workspaceId);
  const task = await createWorkspaceTask(workspaceId, data);
  // A person assigned the new task to a cloud agent: start its run (the task is saved either way).
  const agentRun: { agentRun?: AgentRunOutcome } = task.assigneeAgentId ? reportableRun(await startRunForAssignedTask({ taskId: task.id, actingUserId: userId })) : {};

  revalidatePath(revalidatePathStr);
  return { ...(await resolveTaskAssignees(workspaceId, [task]))[0], ...agentRun };
}

// ─── Update Task ──────────────────────────────────────────────────────────────

export async function updateTask(
  taskId: string,
  data: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    squadId?: string | null;
    assigneeUserId?: string | null;
    assignee?: TaskAssignee;
    ownerName?: string | null;
    storyPoints?: number | null;
    dueDate?: Date | null;
    iteration?: string | null;
  },
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const existing = await requireTask(taskId);
  await validateTaskReferences(existing.workspaceId, data);
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.squadId !== undefined) updateData.squadId = data.squadId;
  Object.assign(updateData, await assignmentUpdate(existing.workspaceId, data));
  if (data.ownerName !== undefined) updateData.ownerName = data.ownerName;
  if (data.storyPoints !== undefined) updateData.storyPoints = data.storyPoints;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
  if (data.iteration !== undefined) updateData.iteration = data.iteration;

  const task = await captureWorkspaceMutation(prisma, "task", "update", "UI", taskId, tx => tx.task.update({
    where: { id: taskId },
    data: updateData,
  }));

  // The assignee became a (different) cloud agent: start its run. Re-saving the same assignee starts nothing.
  const agentRun: { agentRun?: AgentRunOutcome } = task.assigneeAgentId && task.assigneeAgentId !== existing.assigneeAgentId
    ? reportableRun(await startRunForAssignedTask({ taskId, actingUserId: existing.userId, previousAssigneeAgentId: existing.assigneeAgentId }))
    : {};

  revalidatePath(revalidatePathStr);
  return { ...(await resolveTaskAssignees(existing.workspaceId, [task]))[0], ...agentRun };
}

// ─── Move Task Status ─────────────────────────────────────────────────────────

export async function moveTaskStatus(
  taskId: string,
  status: TaskStatus,
  workspaceId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const existing = await requireTask(taskId);
  if (existing.workspaceId !== workspaceId) throw new Error("Not found");
  // Place the moved task at the end of the destination column.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status, NOT: { id: taskId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0;

  await captureWorkspaceMutation(prisma, "task", "update", "UI", taskId, tx => tx.task.update({
    where: { id: taskId },
    data: { status, sortOrder, updatedAt: new Date() },
  }));

  revalidatePath(revalidatePathStr);
}

// ─── Update Sort Order ────────────────────────────────────────────────────────

export async function updateSortOrder(
  taskId: string,
  orderedTaskIds: string[],
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const task = await requireTask(taskId);
  const requestedIds = new Set(orderedTaskIds);
  if (requestedIds.size !== orderedTaskIds.length || !requestedIds.has(taskId)) {
    throw new Error("Invalid task order");
  }

  await prisma.$transaction(async (tx) => {
    const column = await tx.task.findMany({
      where: { workspaceId: task.workspaceId, status: task.status },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sortOrder: true },
    });
    const columnIds = new Set(column.map(({ id }) => id));
    if (orderedTaskIds.some((id) => !columnIds.has(id))) throw new Error("Not found");

    const visibleIds = [...orderedTaskIds];
    const reordered = column.map(({ id }) => requestedIds.has(id) ? visibleIds.shift()! : id);
    const persistedSortOrders = new Map(column.map(({ id, sortOrder }) => [id, sortOrder]));
    const updatedAt = new Date();
    await Promise.all(reordered.map((id, sortOrder) => {
      if (persistedSortOrders.get(id) === sortOrder) return Promise.resolve();
      return tx.task.update({
        where: { id },
        data: { sortOrder, updatedAt },
      });
    }));
  });

  revalidatePath(revalidatePathStr);
}

// ─── Cancel Task ──────────────────────────────────────────────────────────────

export async function cancelTask(taskId: string, revalidatePathStr: string) {
  const prisma = getPrisma();
  await requireTask(taskId);

  await captureWorkspaceMutation(prisma, "task", "update", "UI", taskId, tx => tx.task.update({
    where: { id: taskId },
    data: { status: "CANCELLED", updatedAt: new Date() },
  }));

  revalidatePath(revalidatePathStr);
}

// ─── Link / Unlink Task ───────────────────────────────────────────────────────

export async function linkTask(
  taskId: string,
  linkedType: TaskLinkedType,
  linkedId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const task = await requireTask(taskId);
  await validateTaskLink(task.workspaceId, linkedType, linkedId);
  const existing = await prisma.taskLink.findFirst({ where: { taskId, linkedType, linkedId } });
  if (existing) {
    revalidatePath(revalidatePathStr);
    return existing;
  }

  // Legacy row first (the source of truth), mirrored into entity_links in the same transaction while the flag is on.
  const link = await createTaskLink(prisma, { taskId, linkedType, linkedId, workspaceId: task.workspaceId });

  revalidatePath(revalidatePathStr);
  return link;
}

export async function unlinkTask(linkId: string, revalidatePathStr: string) {
  const prisma = getPrisma();
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const link = await prisma.taskLink.findUnique({ where: { id: linkId }, select: { id: true, taskId: true, linkedType: true, linkedId: true } });
  if (!link) throw new Error("Not found");
  const task = await requireTask(link.taskId);
  await deleteTaskLink(prisma, { link: { id: linkId, taskId: link.taskId, linkedType: link.linkedType, linkedId: link.linkedId }, workspaceId: task.workspaceId });

  revalidatePath(revalidatePathStr);
}

// ─── Add / Link Task from a linked entity's perspective ────────────────────
// Mirrors addTask/linkTask above, but scoped by the *linked entity* (an
// Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc,
// Experiment, or Feedback Item) rather than an existing task. Backs
// components/tasks/linked-tasks-section.tsx, the inline "add/link a delivery
// task" affordance shared across every TaskLink-eligible detail panel — see
// lib/linked-tasks.ts for the matching read side.

async function requireLinkedEntityWorkspace(
  orgSlug: string,
  workspaceSlug: string,
  linkedType: TaskLinkedType,
  linkedId: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Not found");
  // Both callers of this helper (addLinkedTask, linkExistingTask) create or
  // attach a Task -- always a write.
  assertWorkspaceWritable(workspace);
  await validateTaskLink(workspace.id, linkedType, linkedId);
  return workspace;
}

export async function addLinkedTask(
  orgSlug: string,
  workspaceSlug: string,
  linkedType: TaskLinkedType,
  linkedId: string,
  data: { title: string } & AssignmentInput,
  revalidatePathStr: string
) {
  const workspace = await requireLinkedEntityWorkspace(orgSlug, workspaceSlug, linkedType, linkedId);
  const actingUserId = (await auth())?.user?.id;
  const title = data.title.trim();
  if (!title) throw new Error("Title is required");
  const assignment = await assignmentUpdate(workspace.id, data);
  const lastTask = await getPrisma().task.findFirst({
    where: { workspaceId: workspace.id, status: "TODO" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const task = await captureWorkspaceMutation(getPrisma(), "task", "create", "UI", undefined, async tx => {
    const created = await tx.task.create({
      data: {
        workspaceId: workspace.id,
        ...(await allocateOneSeq(tx, workspace.id, "task")),
        title,
        status: "TODO",
        priority: "MEDIUM",
        ...assignment,
        sortOrder: lastTask ? lastTask.sortOrder + 1 : 0,
        links: { create: { linkedType, linkedId } },
      },
    });
    // The nested legacy link is mirrored in the same transaction (flagged).
    await mirrorTaskLinks(tx, { workspaceId: workspace.id, links: [{ taskId: created.id, linkedType, linkedId }] });
    return created;
  });
  const agentRun: { agentRun?: AgentRunOutcome } = task.assigneeAgentId && actingUserId ? reportableRun(await startRunForAssignedTask({ taskId: task.id, actingUserId })) : {};
  revalidatePath(revalidatePathStr);
  return { ...task, ...agentRun };
}

export async function linkExistingTask(
  orgSlug: string,
  workspaceSlug: string,
  linkedType: TaskLinkedType,
  linkedId: string,
  taskId: string,
  revalidatePathStr: string
) {
  const workspace = await requireLinkedEntityWorkspace(orgSlug, workspaceSlug, linkedType, linkedId);
  const task = await getPrisma().task.findFirst({
    where: { id: taskId, workspaceId: workspace.id, status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (!task) throw new Error("Not found");
  const link = await upsertTaskLink(getPrisma(), {
    taskId, linkedType, linkedId,
    workspaceId: workspace.id,
    upsert: tx => tx.taskLink.upsert({
      where: { taskId_linkedType_linkedId: { taskId, linkedType, linkedId } },
      create: { taskId, linkedType, linkedId },
      update: {},
    }),
  });
  revalidatePath(revalidatePathStr);
  return link;
}
