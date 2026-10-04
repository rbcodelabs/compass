"use server";

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { workspaceMutationActor } from "@/lib/workspace-update-mutations"
import { workspaceUpdatesAvailable, recordWorkspaceUpdate, retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getHumanActivityPrisma as getPrisma } from "@/lib/analytics/activity";
import type { Horizon } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";
import { LAUNCH_WORKFLOW_DISABLED_MESSAGE } from "@/lib/launch-checklist";
import { calendarDateToUtcMilliseconds } from "@/lib/roadmap-timeline/calendar-geometry";
import { durationDaysFor, proposeBatch } from "@/lib/roadmap/scheduling";
import { createRoadmapItemsFromSolutions, utcToday, type SolutionScheduleRequest } from "@/lib/roadmap/create-from-solution";
import { ROADMAP_CARD_INCLUDE, toRoadmapCardData } from "@/lib/roadmap/card-data";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

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
  if (relations.solutionId) checks.push(prisma.solution.findFirst({ where: { id: relations.solutionId, workspaceId }, select: { id: true } }));
  if (relations.keyResultId) checks.push(prisma.keyResult.findFirst({ where: { id: relations.keyResultId, objective: { workspaceId } }, select: { id: true } }));
  if (relations.opportunityId) checks.push(prisma.opportunity.findFirst({ where: { id: relations.opportunityId, workspaceId }, select: { id: true } }));
  if (relations.experimentId) checks.push(prisma.experiment.findFirst({ where: { id: relations.experimentId, workspaceId }, select: { id: true } }));
  if (relations.squadId) checks.push(prisma.squad.findFirst({ where: { id: relations.squadId, workspaceId }, select: { id: true } }));
  const records = await Promise.all(checks);
  if (records.some((record) => record === null)) throw new Error("Related record not found");
}

function revalidateRoadmap(): void {
  revalidatePath("/", "layout");
}

/**
 * LAUNCHING/LAUNCHED can never be entered through these generic write paths
 * (only setLaunchTier may create the LAUNCHING checklist transaction). The
 * message differs by workspace state: a workspace with the launch workflow
 * on gets pointed at the real fix (set a launch tier); a workspace with it
 * off gets told the feature is off rather than a message that presumes it's
 * available.
 */
async function assertDirectLaunchWriteBlocked(workspaceId: string, horizon: Horizon): Promise<void> {
  if (!isLaunchHorizon(horizon)) return;

  const workspace = await getPrisma().workspace.findUnique({
    where: { id: workspaceId },
    select: { launchWorkflowEnabled: true },
  });
  if (!workspace?.launchWorkflowEnabled) {
    throw new Error(LAUNCH_WORKFLOW_DISABLED_MESSAGE);
  }
  throw new Error("Use a launch tier to enter LAUNCHING/LAUNCHED");
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
  await requireWorkspaceMember(workspaceId);
  await assertDirectLaunchWriteBlocked(workspaceId, data.horizon);
  validateInclusiveDates(data.startDate ?? null, data.endDate ?? null);
  const prisma = getPrisma();
  await validateRoadmapRelations(prisma, workspaceId, data);
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon: data.horizon, status: "ACTIVE" },
    orderBy: [{ sortOrder: "desc" }, { id: "desc" }],
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", "UI", undefined, tx => tx.roadmapItem.create({ data: {
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
    } }));

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
  const updateData: typeof data & { updatedAt: Date; scheduleEditedAt?: Date } = { updatedAt: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  // A hand-edited schedule stops the item following its solution (migration 075).
  if (data.startDate !== undefined || data.endDate !== undefined) updateData.scheduleEditedAt = new Date();
  if (data.isPrivate !== undefined) updateData.isPrivate = data.isPrivate;
  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "update", "UI", itemId, tx => tx.roadmapItem.update({ where: { id: itemId }, data: updateData }));
  revalidateRoadmap();
  return item;
}

/**
 * Save the roadmap card edit form, including its opportunity relation, through
 * one authenticated workspace-scoped boundary. Relation validation completes
 * before the single update so scalar fields cannot persist when a requested
 * opportunity is missing or belongs to another workspace.
 */
export async function editRoadmapItem(
  itemId: string,
  workspaceId: string,
  data: {
    title?: string;
    description?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
    isPrivate?: boolean;
    opportunityId: string | null;
  },
) {
  await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();
  const current = await prisma.roadmapItem.findFirst({
    where: { id: itemId, workspaceId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      opportunityId: true,
      opportunity: { select: { id: true, title: true } },
    },
  });
  if (!current) throw new Error(ROADMAP_ITEM_NOT_FOUND);

  validateInclusiveDates(
    data.startDate === undefined ? current.startDate : data.startDate,
    data.endDate === undefined ? current.endDate : data.endDate,
  );

  const opportunityChanged = data.opportunityId !== current.opportunityId;
  const opportunity = opportunityChanged && data.opportunityId
    ? await prisma.opportunity.findFirst({
        where: {
          id: data.opportunityId,
          workspaceId,
          status: { not: "ARCHIVED" },
        },
        select: { id: true, title: true },
      })
    : opportunityChanged
      ? null
      : current.opportunity;
  if (data.opportunityId && !opportunity) {
    throw new Error("Opportunity not found");
  }

  const updateData: {
    title?: string;
    description?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
    isPrivate?: boolean;
    opportunityId?: string | null;
    scheduleEditedAt?: Date;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  // A hand-edited schedule stops the item following its solution (migration 075).
  if (data.startDate !== undefined || data.endDate !== undefined) updateData.scheduleEditedAt = new Date();
  if (data.isPrivate !== undefined) updateData.isPrivate = data.isPrivate;
  if (opportunityChanged) updateData.opportunityId = data.opportunityId;

  const updated = await captureWorkspaceMutation(prisma, "roadmapItem", "update", "UI", current.id, tx => tx.roadmapItem.update({
    where: { id: current.id },
    data: updateData,
  }));
  revalidateRoadmap();
  return { ...updated, opportunity };
}

export async function moveItem(itemId: string, horizon: Horizon, workspaceId: string) {
  await requireWorkspaceMember(workspaceId);
  await assertDirectLaunchWriteBlocked(workspaceId, horizon);
  const prisma = getPrisma();
  await requireRoadmapItem(prisma, itemId, workspaceId);
  const lastItem = await prisma.roadmapItem.findFirst({ where: { workspaceId, horizon, status: "ACTIVE", NOT: { id: itemId } }, orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true } });
  await captureWorkspaceMutation(prisma, "roadmapItem", "update", "UI", itemId, tx => tx.roadmapItem.update({ where: { id: itemId }, data: { horizon, sortOrder: lastItem ? lastItem.sortOrder + 1 : 0, updatedAt: new Date() } }));
  revalidateRoadmap();
}

export async function archiveItem(itemId: string, workspaceId: string) {
  await requireWorkspaceMember(workspaceId);
  await requireRoadmapItem(getPrisma(), itemId, workspaceId);
  await captureWorkspaceMutation(getPrisma(), "roadmapItem", "update", "UI", itemId, tx => tx.roadmapItem.update({ where: { id: itemId }, data: { status: "ARCHIVED", updatedAt: new Date() } }));
  revalidateRoadmap();
}

export async function promoteToRoadmap(
  solutionId: string, workspaceId: string, horizon: Horizon, squadId: string | null,
  opportunityId: string | null, dates?: { startDate?: Date; endDate?: Date }, isPrivate?: boolean,
) {
  await requireWorkspaceMember(workspaceId);
  await assertDirectLaunchWriteBlocked(workspaceId, horizon);
  validateInclusiveDates(dates?.startDate ?? null, dates?.endDate ?? null);
  const prisma = getPrisma();

  const solution = await prisma.solution.findFirst({
    where: { id: solutionId, workspaceId },
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

  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", "UI", undefined, tx => tx.roadmapItem.create({ data: {
      workspaceId,
      title: solution.title,
      horizon,
      sortOrder,
      solutionId,
      squadId: solution.opportunity?.squadId ?? squadId,
      opportunityId: solutionOpportunityId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }));

  revalidateRoadmap();
  return { ...item, horizon };
}

export async function promoteFeedbackToRoadmap(
  feedbackId: string, workspaceId: string, horizon: Horizon,
  dates?: { startDate?: Date; endDate?: Date }, isPrivate?: boolean,
) {
  await requireWorkspaceMember(workspaceId);
  await assertDirectLaunchWriteBlocked(workspaceId, horizon);
  validateInclusiveDates(dates?.startDate ?? null, dates?.endDate ?? null);
  const prisma = getPrisma();
  const feedback = await prisma.feedbackItem.findFirst({ where: { id: feedbackId, workspaceId }, select: { title: true } });
  if (!feedback) throw new Error("Feedback item not found");
  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" }, orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", "UI", undefined, tx => tx.roadmapItem.create({ data: {
      workspaceId,
      title: feedback.title,
      horizon,
      sortOrder,
      feedbackId,
      startDate: dates?.startDate,
      endDate: dates?.endDate,
      isPrivate: isPrivate ?? false,
    } }));

  revalidateRoadmap();
  return { ...item, horizon };
}

export async function updateSortOrder(itemId: string, workspaceId: string, sortOrder: number) {
  await requireWorkspaceMember(workspaceId);
  const prisma = getPrisma();
  await requireRoadmapItem(prisma, itemId, workspaceId);
  await captureWorkspaceMutation(prisma, "roadmapItem", "update", "UI", itemId, tx => tx.roadmapItem.update({ where: { id: itemId }, data: { sortOrder, updatedAt: new Date() } }));
  revalidateRoadmap();
}

export async function rescheduleRoadmapItem(
  itemId: string, workspaceId: string,
  data: { horizon: Horizon; startDate: Date | null; endDate: Date | null },
) {
  await requireWorkspaceMember(workspaceId);
  await assertDirectLaunchWriteBlocked(workspaceId, data.horizon);
  validateInclusiveDates(data.startDate, data.endDate);
  const prisma = getPrisma();
  const capture = await workspaceUpdatesAvailable(prisma);
  const actor = capture ? await workspaceMutationActor("UI") : null;
  const item = await retryUpdatesTransaction(prisma, async (tx) => {
    const database = tx as unknown as Database;
    const current = await requireRoadmapItem(database, itemId, workspaceId);
    if (current.status !== "ACTIVE") throw new Error(ROADMAP_ITEM_NOT_FOUND);
    let sortOrder = current.sortOrder;
    if (current.horizon !== data.horizon) {
      const lastItem = await database.roadmapItem.findFirst({
        where: { workspaceId, horizon: data.horizon, status: "ACTIVE", NOT: { id: itemId } },
        orderBy: [{ sortOrder: "desc" }, { id: "desc" }], select: { sortOrder: true },
      });
      sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;
    }
    const updated = await database.roadmapItem.update({
      where: { id: current.id },
      data: { horizon: data.horizon, startDate: data.startDate, endDate: data.endDate,
        sortOrder, updatedAt: new Date(), scheduleEditedAt: new Date() },
    });
    if (capture && actor) await recordWorkspaceUpdate(tx, { workspaceId, entityType: "ROADMAP_ITEM", entityId: itemId, kind: "STATUS_CHANGED", before: current.horizon, after: updated.horizon, ...actor });
    return updated;
  });
  revalidateRoadmap();
  return {
    id: item.id,
    horizon: item.horizon,
    startDate: item.startDate?.toISOString() ?? null,
    endDate: item.endDate?.toISOString() ?? null,
    updatedAt: item.updatedAt.toISOString(),
  };
}

// ─── Build the roadmap from Discovery ────────────────────────────────────────
// Every create below goes through createRoadmapItemsFromSolutions, the same
// helper the MCP tools and Building auto-sync use: one ACTIVE item per solution,
// squad / key result / title inherited from the solution, a suggested
// non-overlapping slot, and the creator recorded on the row.

export type ScheduleSolutionRequest = {
  solutionId: string;
  horizon?: "NOW" | "NEXT" | "LATER";
  /** `undefined` inherits the opportunity's squad; `null` means no squad. */
  squadId?: string | null;
  /** Inclusive `YYYY-MM-DD` dates. Omit both to take the suggested slot. */
  startDate?: string;
  endDate?: string;
};

export type ScheduleSolutionsResult = {
  /** Newly created items, shaped exactly as the roadmap page renders them. */
  created: RoadmapCardData[];
  /** Solutions that were already on the roadmap; nothing was added for them. */
  existing: Array<{ solutionId: string; itemId: string }>;
  missing: string[];
};

export type RoadmapBuildPreset = "validated" | "top-scored" | "building";
const SCHEDULE_HORIZONS = new Set(["NOW", "NEXT", "LATER"]);
const TOP_SCORE_THRESHOLD = 70;
const MAX_BATCH_SIZE = 100;

function parseCalendarDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    calendarDateToUtcMilliseconds(value);
  } catch {
    throw new Error(`${label} must be a YYYY-MM-DD date`);
  }
  return value;
}

async function loadCreatedCards(prisma: Database, workspaceId: string, ids: string[]): Promise<RoadmapCardData[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.roadmapItem.findMany({ where: { id: { in: ids }, workspaceId }, include: ROADMAP_CARD_INCLUDE });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toRoadmapCardData(row)] : [];
  });
}

/**
 * Create linked roadmap items for the given solutions. Idempotent: a solution
 * that already has an ACTIVE item is reported in `existing` and left alone.
 * `today` is the caller's local calendar date so "first free slot at or after
 * today" matches what the user sees.
 */
export async function scheduleSolutionsToRoadmap(
  workspaceId: string,
  requests: ScheduleSolutionRequest[],
  today?: string,
): Promise<ScheduleSolutionsResult> {
  const userId = await requireWorkspaceMember(workspaceId);
  if (requests.length === 0) return { created: [], existing: [], missing: [] };
  if (requests.length > MAX_BATCH_SIZE) throw new Error(`Schedule at most ${MAX_BATCH_SIZE} solutions at a time`);
  const prisma = getPrisma();
  const normalized: SolutionScheduleRequest[] = requests.map((request) => {
    if (request.horizon !== undefined && !SCHEDULE_HORIZONS.has(request.horizon)) throw new Error("Invalid horizon");
    const startDate = parseCalendarDate(request.startDate, "Start date");
    const endDate = parseCalendarDate(request.endDate, "End date");
    if ((startDate === undefined) !== (endDate === undefined) && endDate !== undefined) throw new Error("An end date needs a start date");
    return { solutionId: request.solutionId, horizon: request.horizon, squadId: request.squadId, startDate, endDate };
  });
  const result = await createRoadmapItemsFromSolutions(
    prisma,
    { workspaceId, source: "UI", captureSource: "UI", userId, today: parseCalendarDate(today, "Today") },
    normalized,
  );
  revalidateRoadmap();
  return {
    created: await loadCreatedCards(prisma, workspaceId, result.created.map((item) => item.id)),
    existing: result.existing,
    missing: result.missing,
  };
}

/**
 * The empty-roadmap "Build from discovery" flow: pick a preset of unscheduled
 * solutions and place them at proposed non-overlapping slots, highest score
 * first within each squad.
 */
export async function buildRoadmapFromDiscovery(
  workspaceId: string,
  preset: RoadmapBuildPreset,
  today?: string,
): Promise<ScheduleSolutionsResult> {
  const userId = await requireWorkspaceMember(workspaceId);
  const todayDate = parseCalendarDate(today, "Today") ?? utcToday();
  const prisma = getPrisma();
  const statuses = preset === "building" ? ["IN_DELIVERY"] : preset === "validated" ? ["VALIDATED"] : ["VALIDATED", "IN_DELIVERY"];
  const [solutions, occupied] = await Promise.all([
    prisma.solution.findMany({
      where: {
        workspaceId,
        status: { in: statuses },
        roadmapItems: { none: { status: "ACTIVE" } },
        ...(preset === "top-scored" ? { score: { is: { normalizedScore: { gte: TOP_SCORE_THRESHOLD } } } } : {}),
      },
      select: { id: true, opportunity: { select: { squadId: true } }, score: { select: { normalizedScore: true } } },
      orderBy: { createdAt: "asc" },
      take: MAX_BATCH_SIZE,
    }),
    prisma.roadmapItem.findMany({
      where: { workspaceId, status: "ACTIVE", startDate: { not: null }, endDate: { not: null } },
      select: { squadId: true, startDate: true, endDate: true },
    }),
  ]);
  const proposals = proposeBatch({
    candidates: solutions.map((solution) => ({
      solutionId: solution.id,
      squadId: solution.opportunity.squadId ?? null,
      score: solution.score?.normalizedScore ?? null,
      durationDays: durationDaysFor(null),
    })),
    existing: occupied.map((item) => ({
      squadId: item.squadId,
      start: (item.startDate as Date).toISOString().slice(0, 10),
      end: (item.endDate as Date).toISOString().slice(0, 10),
    })),
    today: todayDate,
  });
  const result = await createRoadmapItemsFromSolutions(
    prisma,
    { workspaceId, source: "UI", captureSource: "UI", userId, today: todayDate },
    proposals.map((proposal) => ({
      solutionId: proposal.solutionId,
      squadId: proposal.squadId,
      horizon: proposal.horizon,
      startDate: proposal.start,
      endDate: proposal.end,
    })),
  );
  revalidateRoadmap();
  return {
    created: await loadCreatedCards(prisma, workspaceId, result.created.map((item) => item.id)),
    existing: result.existing,
    missing: result.missing,
  };
}

/**
 * Undo for any create above (and for an auto-added item): archive the items.
 * The source solutions are never touched, so each one simply returns to the
 * "Ready to schedule" rail. An archived auto-created item stays behind as the
 * marker that stops Building auto-sync re-adding it.
 */
export async function undoRoadmapCreate(workspaceId: string, itemIds: string[]): Promise<{ archived: string[] }> {
  await requireWorkspaceMember(workspaceId);
  if (itemIds.length > MAX_BATCH_SIZE) throw new Error(`Undo at most ${MAX_BATCH_SIZE} items at a time`);
  const prisma = getPrisma();
  const items = await prisma.roadmapItem.findMany({
    where: { id: { in: itemIds }, workspaceId, status: "ACTIVE" },
    select: { id: true },
  });
  for (const item of items) {
    await captureWorkspaceMutation(prisma, "roadmapItem", "update", "UI", item.id, (tx) =>
      tx.roadmapItem.update({ where: { id: item.id }, data: { status: "ARCHIVED", updatedAt: new Date() } }),
    );
  }
  revalidateRoadmap();
  return { archived: items.map((item) => item.id) };
}
