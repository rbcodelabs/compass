"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import type { Horizon } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";
import { createRoadmapItemWithNowGate, transitionRoadmapItemWithNowGate } from "@/lib/now-gate-runtime";
import { updateRoadmapItemWithCapacityRelease } from "@/lib/capacity-ledger";
import { isOrgAdminRole } from "@/lib/roles";

async function requireWorkspaceMember(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getPrisma().workspace.findFirst({
    where: { id: workspaceId },
    select: { members: { where: { userId: session.user.id }, select: { id: true } }, organization: { select: { members: { where: { userId: session.user.id }, select: { role: true } } } } },
  });
  if (!workspace || (workspace.members.length === 0 && !isOrgAdminRole(workspace.organization.members[0]?.role))) throw new Error("Workspace not found");
  return session.user.id;
}

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
  const userId = await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();

  if (data.solutionId && !await prisma.solution.findFirst({ where: { id: data.solutionId, opportunity: { workspaceId } }, select: { id: true } })) throw new Error("Linked Solution not found");
  if (data.opportunityId && !await prisma.opportunity.findFirst({ where: { id: data.opportunityId, workspaceId }, select: { id: true } })) throw new Error("Linked Opportunity not found");
  if (data.experimentId && !await prisma.experiment.findFirst({ where: { id: data.experimentId, workspaceId }, select: { id: true } })) throw new Error("Linked Experiment not found");
  if (data.keyResultId && !await prisma.keyResult.findFirst({ where: { id: data.keyResultId, objective: { cycle: { workspaceId } } }, select: { id: true } })) throw new Error("Linked Key Result not found");

  // Place new item at the end of its column by finding the current max sortOrder.
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon: data.horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await createRoadmapItemWithNowGate({ workspaceId, requestedHorizon: data.horizon, ingressKey: "ui.roadmap.add", actor: { kind: "USER", id: userId }, create: (database, initialHorizon) => database.roadmapItem.create({ data: {
      workspaceId,
      title: data.title,
      description: data.description,
      horizon: initialHorizon,
      sortOrder,
      solutionId: data.solutionId,
      keyResultId: data.keyResultId,
      opportunityId: data.opportunityId,
      experimentId: data.experimentId,
      startDate: data.startDate,
      endDate: data.endDate,
      isPrivate: data.isPrivate ?? false,
    } }) });

  revalidatePath(revalidatePathStr);
  return { ...item, horizon: data.horizon };
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
  const userId = await requireWorkspaceMember(workspaceId);
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
  const current = await prisma.roadmapItem.findFirst({ where: { id: itemId, workspaceId }, select: { horizon: true } });
  if (!current) throw new Error("Roadmap item not found");
  await transitionRoadmapItemWithNowGate({ workspaceId, roadmapItemId: itemId, currentHorizon: current.horizon, requestedHorizon: horizon, ingressKey: "ui.roadmap.move", actor: { kind: "USER", id: userId }, mutate: async (database) => {
    const lastItem = await database.roadmapItem.findFirst({ where: { workspaceId, horizon, status: "ACTIVE", NOT: { id: itemId } }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    return updateRoadmapItemWithCapacityRelease(itemId, { horizon, sortOrder: lastItem ? lastItem.sortOrder + 1 : 0 }, database);
  } });

  revalidatePath(revalidatePathStr);
}

// ─── Archive Item ─────────────────────────────────────────────────────────────

export async function archiveItem(
  itemId: string,
  revalidatePathStr: string
) {
  await updateRoadmapItemWithCapacityRelease(itemId, { status: "ARCHIVED" });

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
  const userId = await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();

  const solution = await prisma.solution.findFirst({
    where: { id: solutionId, opportunity: { workspaceId } },
    select: { title: true, opportunity: { select: { id: true, squadId: true } } },
  });
  if (!solution) throw new Error("Solution not found");
  if (opportunityId && opportunityId !== solution.opportunity.id) throw new Error("Solution opportunity mismatch");
  if (squadId && squadId !== solution.opportunity.squadId) throw new Error("Solution squad mismatch");

  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await createRoadmapItemWithNowGate({ workspaceId, requestedHorizon: horizon, ingressKey: "ui.solution.promote", actor: { kind: "USER", id: userId }, create: (database, initialHorizon) => database.roadmapItem.create({ data: {
      workspaceId,
      title: solution.title,
      horizon: initialHorizon,
      sortOrder,
      solutionId,
      squadId: solution.opportunity.squadId,
      opportunityId: solution.opportunity.id,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }) });

  revalidatePath(`/[orgSlug]/[workspaceSlug]/roadmap`, "page");
  return { ...item, horizon };
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
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();

  const feedback = await prisma.feedbackItem.findFirst({
    where: {
      id: feedbackId,
      workspaceId,
      workspace: { members: { some: { userId: session.user.id } } },
    },
    select: { title: true },
  });
  if (!feedback) throw new Error("Feedback item not found");

  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await createRoadmapItemWithNowGate({ workspaceId, requestedHorizon: horizon, ingressKey: "ui.feedback.promote", actor: { kind: "USER", id: session.user.id }, create: (database, initialHorizon) => database.roadmapItem.create({ data: {
      workspaceId,
      title: feedback.title,
      horizon: initialHorizon,
      sortOrder,
      feedbackId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }) });

  revalidatePath(revalidatePathStr);
  return { ...item, horizon };
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
