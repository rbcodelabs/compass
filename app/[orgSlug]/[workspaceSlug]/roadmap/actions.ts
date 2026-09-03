"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import type { Horizon } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";
import { createRoadmapItemWithNowGate, evaluateDirectNowIngress, transitionRoadmapItemWithNowGate } from "@/lib/now-gate-runtime";
import { releaseNowCapacityInTransaction, updateRoadmapItemWithCapacityRelease } from "@/lib/capacity-ledger";

type Database = ReturnType<typeof getPrisma>;
const ROADMAP_ITEM_NOT_FOUND = "Roadmap item not found";

async function requireWorkspaceMember(workspaceId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const member = await getPrisma().workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
    select: { id: true },
  });
  if (!member) throw new Error("Workspace not found");
  return session.user.id;
}

async function requireRoadmapItem(prisma: Database, itemId: string, workspaceId: string) {
  const item = await prisma.roadmapItem.findFirst({
    where: { id: itemId, workspaceId },
    select: { id: true, horizon: true, status: true, sortOrder: true, startDate: true, endDate: true },
  });
  if (!item) throw new Error(ROADMAP_ITEM_NOT_FOUND);
  return item;
}

async function validateRoadmapRelations(
  prisma: Database,
  workspaceId: string,
  relations: { solutionId?: string; keyResultId?: string; opportunityId?: string; experimentId?: string; squadId?: string | null },
) {
  const checks: Array<Promise<unknown>> = [];
  if (relations.solutionId) checks.push(prisma.solution.findFirst({ where: { id: relations.solutionId, opportunity: { workspaceId } }, select: { id: true } }));
  if (relations.keyResultId) checks.push(prisma.keyResult.findFirst({ where: { id: relations.keyResultId, objective: { cycle: { workspaceId } } }, select: { id: true } }));
  if (relations.opportunityId) checks.push(prisma.opportunity.findFirst({ where: { id: relations.opportunityId, workspaceId }, select: { id: true } }));
  if (relations.experimentId) checks.push(prisma.experiment.findFirst({ where: { id: relations.experimentId, workspaceId }, select: { id: true } }));
  if (relations.squadId) checks.push(prisma.squad.findFirst({ where: { id: relations.squadId, workspaceId }, select: { id: true } }));
  const records = await Promise.all(checks);
  if (records.some((record) => record === null)) throw new Error("Related record not found");
}

function revalidateRoadmap(): void {
  revalidatePath("/", "layout");
}

function assertDirectLaunchWriteBlocked(horizon: Horizon): void {
  if (isLaunchHorizon(horizon)) {
    throw new Error("Use a launch tier to enter LAUNCHING/LAUNCHED");
  }
}

function validateInclusiveDates(startDate: Date | null, endDate: Date | null): void {
  if ((startDate === null) !== (endDate === null) || (startDate && endDate && startDate > endDate)) {
    throw new Error("Roadmap dates must be an inclusive range with start on or before end");
  }
}

export async function addRoadmapItem(
  workspaceId: string,
  data: {
    title: string; description?: string; horizon: Horizon; solutionId?: string; keyResultId?: string;
    opportunityId?: string; experimentId?: string; startDate?: Date; endDate?: Date; isPrivate?: boolean;
  },
) {
  const userId = await requireWorkspaceMember(workspaceId);
  assertDirectLaunchWriteBlocked(data.horizon);
  validateInclusiveDates(data.startDate ?? null, data.endDate ?? null);
  const prisma = getPrisma();
  await validateRoadmapRelations(prisma, workspaceId, data);
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon: data.horizon, status: "ACTIVE" },
    orderBy: [{ sortOrder: "desc" }, { id: "desc" }],
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

  revalidateRoadmap();
  return { ...item, horizon: data.horizon };
}

export async function updateRoadmapItem(
  itemId: string,
  workspaceId: string,
  data: { title?: string; description?: string; startDate?: Date | null; endDate?: Date | null; isPrivate?: boolean },
) {
  await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();
  const current = await requireRoadmapItem(prisma, itemId, workspaceId);
  if (data.startDate !== undefined || data.endDate !== undefined) {
    validateInclusiveDates(data.startDate === undefined ? current.startDate : data.startDate, data.endDate === undefined ? current.endDate : data.endDate);
  }
  const updateData: typeof data & { updatedAt: Date } = { updatedAt: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  if (data.isPrivate !== undefined) updateData.isPrivate = data.isPrivate;
  const item = await prisma.roadmapItem.update({ where: { id: itemId }, data: updateData });
  revalidateRoadmap();
  return item;
}

export async function moveItem(itemId: string, horizon: Horizon, workspaceId: string) {
  const userId = await requireWorkspaceMember(workspaceId);
  assertDirectLaunchWriteBlocked(horizon);
  const prisma = getPrisma();
  const current = await requireRoadmapItem(prisma, itemId, workspaceId);
  await transitionRoadmapItemWithNowGate({ workspaceId, roadmapItemId: itemId, currentHorizon: current.horizon, requestedHorizon: horizon, ingressKey: "ui.roadmap.move", actor: { kind: "USER", id: userId }, mutate: async (database) => {
    const lastItem = await database.roadmapItem.findFirst({ where: { workspaceId, horizon, status: "ACTIVE", NOT: { id: itemId } }, orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true } });
    return updateRoadmapItemWithCapacityRelease(itemId, { horizon, sortOrder: lastItem ? lastItem.sortOrder + 1 : 0 }, database);
  } });
  revalidateRoadmap();
}

export async function archiveItem(itemId: string, workspaceId: string) {
  await requireWorkspaceMember(workspaceId);
  await requireRoadmapItem(getPrisma(), itemId, workspaceId);
  await updateRoadmapItemWithCapacityRelease(itemId, { status: "ARCHIVED" });
  revalidateRoadmap();
}

export async function promoteToRoadmap(
  solutionId: string, workspaceId: string, horizon: Horizon, squadId: string | null,
  opportunityId: string | null, dates?: { startDate?: Date; endDate?: Date }, isPrivate?: boolean,
) {
  const userId = await requireWorkspaceMember(workspaceId);
  assertDirectLaunchWriteBlocked(horizon);
  validateInclusiveDates(dates?.startDate ?? null, dates?.endDate ?? null);
  const prisma = getPrisma();

  const solution = await prisma.solution.findFirst({
    where: { id: solutionId, opportunity: { workspaceId } },
    select: { title: true, opportunityId: true, opportunity: { select: { id: true, squadId: true } } },
  });
  if (!solution) throw new Error("Solution not found");
  await validateRoadmapRelations(prisma, workspaceId, { opportunityId: opportunityId ?? undefined, squadId });
  const solutionOpportunityId = solution.opportunity?.id ?? solution.opportunityId;
  if (opportunityId && opportunityId !== solutionOpportunityId) throw new Error("Solution opportunity mismatch");
  if (squadId && solution.opportunity?.squadId !== undefined && squadId !== solution.opportunity.squadId) throw new Error("Solution squad mismatch");
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" }, orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await createRoadmapItemWithNowGate({ workspaceId, requestedHorizon: horizon, ingressKey: "ui.solution.promote", actor: { kind: "USER", id: userId }, create: (database, initialHorizon) => database.roadmapItem.create({ data: {
      workspaceId,
      title: solution.title,
      horizon: initialHorizon,
      sortOrder,
      solutionId,
      squadId: solution.opportunity?.squadId ?? squadId,
      opportunityId: solutionOpportunityId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }) });

  revalidateRoadmap();
  return { ...item, horizon };
}

export async function promoteFeedbackToRoadmap(
  feedbackId: string, workspaceId: string, horizon: Horizon,
  dates?: { startDate?: Date; endDate?: Date }, isPrivate?: boolean,
) {
  const userId = await requireWorkspaceMember(workspaceId);
  assertDirectLaunchWriteBlocked(horizon);
  validateInclusiveDates(dates?.startDate ?? null, dates?.endDate ?? null);
  const prisma = getPrisma();
  const feedback = await prisma.feedbackItem.findFirst({ where: { id: feedbackId, workspaceId }, select: { title: true } });
  if (!feedback) throw new Error("Feedback item not found");
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" }, orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await createRoadmapItemWithNowGate({ workspaceId, requestedHorizon: horizon, ingressKey: "ui.feedback.promote", actor: { kind: "USER", id: userId }, create: (database, initialHorizon) => database.roadmapItem.create({ data: {
      workspaceId,
      title: feedback.title,
      horizon: initialHorizon,
      sortOrder,
      feedbackId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }) });

  revalidateRoadmap();
  return { ...item, horizon };
}

export async function updateSortOrder(itemId: string, workspaceId: string, sortOrder: number) {
  await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();
  await requireRoadmapItem(prisma, itemId, workspaceId);
  await prisma.roadmapItem.update({ where: { id: itemId }, data: { sortOrder, updatedAt: new Date() } });
  revalidateRoadmap();
}

export async function rescheduleRoadmapItem(
  itemId: string, workspaceId: string,
  data: { horizon: Horizon; startDate: Date | null; endDate: Date | null },
) {
  const userId = await requireWorkspaceMember(workspaceId);
  assertDirectLaunchWriteBlocked(data.horizon);
  validateInclusiveDates(data.startDate, data.endDate);
  const prisma = getPrisma();
  const item = await prisma.$transaction(async (tx) => {
    const database = tx as unknown as Database;
    const current = await requireRoadmapItem(database, itemId, workspaceId);
    if (current.status !== "ACTIVE") throw new Error(ROADMAP_ITEM_NOT_FOUND);
    await evaluateDirectNowIngress({
      workspaceId,
      roadmapItemId: itemId,
      currentHorizon: current.horizon,
      requestedHorizon: data.horizon,
      ingressKey: "ui.roadmap.reschedule",
      actor: { kind: "USER", id: userId },
    }, database, { telemetryFailure: "throw" });
    let sortOrder = current.sortOrder;
    if (current.horizon !== data.horizon) {
      const lastItem = await database.roadmapItem.findFirst({
        where: { workspaceId, horizon: data.horizon, status: "ACTIVE", NOT: { id: itemId } },
        orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true },
      });
      sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;
    }
    if (current.horizon === "NOW" && data.horizon !== "NOW") await releaseNowCapacityInTransaction(database, current.id);
    return database.roadmapItem.update({
      where: { id: current.id },
      data: { horizon: data.horizon, startDate: data.startDate, endDate: data.endDate,
        sortOrder, updatedAt: new Date() },
    });
  });
  revalidateRoadmap();
  return item;
}
