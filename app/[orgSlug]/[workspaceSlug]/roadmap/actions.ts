"use server";

import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type { Horizon } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";

// ─── Add Roadmap Item ─────────────────────────────────────────────────────────

export async function addRoadmapItem(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    horizon: Horizon;
    solutionId?: string;
    keyResultId?: string;
    opportunityId?: string;
    experimentId?: string;
    startDate?: Date;
    endDate?: Date;
    isPrivate?: boolean;
  },
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  // Place new item at the end of its column by finding the current max sortOrder.
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon: data.horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await prisma.roadmapItem.create({
    data: {
      workspaceId,
      title: data.title,
      description: data.description,
      horizon: data.horizon,
      sortOrder,
      solutionId: data.solutionId,
      keyResultId: data.keyResultId,
      opportunityId: data.opportunityId,
      experimentId: data.experimentId,
      startDate: data.startDate,
      endDate: data.endDate,
      isPrivate: data.isPrivate ?? false,
    },
  });

  revalidatePath(revalidatePathStr);
  return item;
}

// ─── Update Roadmap Item ──────────────────────────────────────────────────────

export async function updateRoadmapItem(
  itemId: string,
  data: {
    title?: string;
    description?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    isPrivate?: boolean;
  },
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  const updateData: {
    title?: string;
    description?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    isPrivate?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  if (data.isPrivate !== undefined) updateData.isPrivate = data.isPrivate;

  const item = await prisma.roadmapItem.update({
    where: { id: itemId },
    data: updateData,
  });

  revalidatePath(revalidatePathStr);
  return item;
}

// ─── Move Item (change horizon) ───────────────────────────────────────────────

export async function moveItem(
  itemId: string,
  horizon: Horizon,
  workspaceId: string,
  revalidatePathStr: string
) {
  // A bare move can't enter a launch horizon — LAUNCHING requires a tier +
  // checklist (setLaunchTier), and LAUNCHED its own transition. The board's
  // drag handler already intercepts these drops and opens the panel instead;
  // this is the server-side backstop mirroring the MCP move guard.
  if (isLaunchHorizon(horizon)) {
    throw new Error(
      "Use a launch tier to move an item into LAUNCHING/LAUNCHED — it can't be set by a plain move.",
    );
  }

  const prisma = getPrisma();

  // Place the moved item at the end of the destination column.
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE", NOT: { id: itemId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  await prisma.roadmapItem.update({
    where: { id: itemId },
    data: { horizon, sortOrder },
  });

  revalidatePath(revalidatePathStr);
}

// ─── Archive Item ─────────────────────────────────────────────────────────────

export async function archiveItem(
  itemId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  await prisma.roadmapItem.update({
    where: { id: itemId },
    data: { status: "ARCHIVED" },
  });

  revalidatePath(revalidatePathStr);
}

// ─── Promote Solution to Roadmap ──────────────────────────────────────────────

export async function promoteToRoadmap(
  solutionId: string,
  workspaceId: string,
  horizon: Horizon,
  squadId: string | null,
  opportunityId: string | null,
  dates?: { startDate?: Date; endDate?: Date },
  isPrivate?: boolean
) {
  const prisma = getPrisma();

  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { title: true },
  });
  if (!solution) throw new Error("Solution not found");

  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await prisma.roadmapItem.create({
    data: {
      workspaceId,
      title: solution.title,
      horizon,
      sortOrder,
      solutionId,
      squadId: squadId ?? null,
      opportunityId: opportunityId ?? null,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    },
  });

  revalidatePath(`/[orgSlug]/[workspaceSlug]/roadmap`, "page");
  return item;
}

// ─── Promote Feedback (Bug) to Roadmap ────────────────────────────────────────

export async function promoteFeedbackToRoadmap(
  feedbackId: string,
  workspaceId: string,
  horizon: Horizon,
  revalidatePathStr: string,
  dates?: { startDate?: Date; endDate?: Date },
  isPrivate?: boolean
) {
  const prisma = getPrisma();

  const feedback = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: { title: true },
  });
  if (!feedback) throw new Error("Feedback item not found");

  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await prisma.roadmapItem.create({
    data: {
      workspaceId,
      title: feedback.title,
      horizon,
      sortOrder,
      feedbackId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    },
  });

  revalidatePath(revalidatePathStr);
  return item;
}

// ─── Update Sort Order ────────────────────────────────────────────────────────

export async function updateSortOrder(
  itemId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();

  await prisma.roadmapItem.update({
    where: { id: itemId },
    data: { sortOrder },
  });

  revalidatePath(revalidatePathStr);
}
