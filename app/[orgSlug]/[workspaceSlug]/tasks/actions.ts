"use server";

import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types";

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
    ownerName?: string | null;
    storyPoints?: number | null;
    dueDate?: Date | null;
    iteration?: string | null;
  },
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const status = data.status ?? "TODO";

  // Place new task at the end of its status column, same convention as
  // roadmap/actions.ts addRoadmapItem.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0;

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: data.title,
      description: data.description,
      status,
      priority: data.priority ?? "MEDIUM",
      squadId: data.squadId,
      parentTaskId: data.parentTaskId,
      assigneeUserId: data.assigneeUserId,
      ownerName: data.ownerName,
      storyPoints: data.storyPoints,
      dueDate: data.dueDate,
      iteration: data.iteration,
      sortOrder,
    },
  });

  revalidatePath(revalidatePathStr);
  return task;
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
    ownerName?: string | null;
    storyPoints?: number | null;
    dueDate?: Date | null;
    iteration?: string | null;
  },
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.squadId !== undefined) updateData.squadId = data.squadId;
  if (data.assigneeUserId !== undefined) updateData.assigneeUserId = data.assigneeUserId;
  if (data.ownerName !== undefined) updateData.ownerName = data.ownerName;
  if (data.storyPoints !== undefined) updateData.storyPoints = data.storyPoints;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
  if (data.iteration !== undefined) updateData.iteration = data.iteration;

  const task = await prisma.task.update({
    where: { id: taskId },
    data: updateData,
  });

  revalidatePath(revalidatePathStr);
  return task;
}

// ─── Move Task Status ─────────────────────────────────────────────────────────

export async function moveTaskStatus(
  taskId: string,
  status: TaskStatus,
  workspaceId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  // Place the moved task at the end of the destination column.
  const lastTask = await prisma.task.findFirst({
    where: { workspaceId, status, NOT: { id: taskId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastTask ? lastTask.sortOrder + 1 : 0;

  await prisma.task.update({
    where: { id: taskId },
    data: { status, sortOrder, updatedAt: new Date() },
  });

  revalidatePath(revalidatePathStr);
}

// ─── Update Sort Order ────────────────────────────────────────────────────────

export async function updateSortOrder(
  taskId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  await prisma.task.update({
    where: { id: taskId },
    data: { sortOrder, updatedAt: new Date() },
  });

  revalidatePath(revalidatePathStr);
}

// ─── Cancel Task ──────────────────────────────────────────────────────────────

export async function cancelTask(taskId: string, revalidatePathStr: string) {
  const prisma = getPrisma();

  await prisma.task.update({
    where: { id: taskId },
    data: { status: "CANCELLED", updatedAt: new Date() },
  });

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

  await prisma.taskLink.delete({ where: { id: linkId } });

  revalidatePath(revalidatePathStr);
}
