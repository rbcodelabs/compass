"use server";

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { assignmentUpdate, resolveTaskAssignees, validateTaskLink, validateTaskReferences, type AssignmentInput, type TaskAssignee } from "@/lib/task-assignment";
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types";

async function requireTaskWorkspace(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const membership = await getPrisma().workspaceMember.findFirst({ where: { workspaceId, userId: session.user.id }, select: { id: true } });
  if (!membership) throw new Error("Not found");
}

async function requireTask(taskId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const task = await getPrisma().task.findUnique({ where: { id: taskId }, select: { workspaceId: true, status: true } });
  if (!task) throw new Error("Not found");
  await requireTaskWorkspace(task.workspaceId);
  return task;
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
  const prisma = getPrisma();
  await requireTaskWorkspace(workspaceId);
  await validateTaskReferences(workspaceId, data);
  const assignment = await assignmentUpdate(workspaceId, data);
  const status = data.status ?? "TODO";

  // Place new task at the end of its status column, same convention as
  // roadmap/actions.ts addRoadmapItem.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0;

  const task = await captureWorkspaceMutation(prisma, "task", "create", "UI", undefined, tx => tx.task.create({
    data: {
      workspaceId,
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
    },
  }));

  revalidatePath(revalidatePathStr);
  return (await resolveTaskAssignees(workspaceId, [task]))[0];
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

  revalidatePath(revalidatePathStr);
  return (await resolveTaskAssignees(existing.workspaceId, [task]))[0];
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

  const link = await prisma.taskLink.create({ data: { taskId, linkedType, linkedId } });

  revalidatePath(revalidatePathStr);
  return link;
}

export async function unlinkTask(linkId: string, revalidatePathStr: string) {
  const prisma = getPrisma();
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const link = await prisma.taskLink.findUnique({ where: { id: linkId }, select: { taskId: true } });
  if (!link) throw new Error("Not found");
  await requireTask(link.taskId);
  await prisma.taskLink.delete({ where: { id: linkId } });

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
  const title = data.title.trim();
  if (!title) throw new Error("Title is required");
  const assignment = await assignmentUpdate(workspace.id, data);
  const lastTask = await getPrisma().task.findFirst({
    where: { workspaceId: workspace.id, status: "TODO" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const task = await captureWorkspaceMutation(getPrisma(), "task", "create", "UI", undefined, tx => tx.task.create({
    data: {
      workspaceId: workspace.id,
      title,
      status: "TODO",
      priority: "MEDIUM",
      ...assignment,
      sortOrder: lastTask ? lastTask.sortOrder + 1 : 0,
      links: { create: { linkedType, linkedId } },
    },
  }));
  revalidatePath(revalidatePathStr);
  return task;
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
  const link = await getPrisma().taskLink.upsert({
    where: { taskId_linkedType_linkedId: { taskId, linkedType, linkedId } },
    create: { taskId, linkedType, linkedId },
    update: {},
  });
  revalidatePath(revalidatePathStr);
  return link;
}
