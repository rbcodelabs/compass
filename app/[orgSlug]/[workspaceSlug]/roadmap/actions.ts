"use server";

import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type { Horizon } from "@/lib/types";

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
    },
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
  opportunityId: string | null
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
    },
  });

  revalidatePath(`/[orgSlug]/[workspaceSlug]/roadmap`, "page");
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
