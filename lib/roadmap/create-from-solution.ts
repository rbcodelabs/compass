/**
 * The one place a roadmap item is created from a Discovery solution.
 *
 * The roadmap UI (drag from the rail, palette, build-from-discovery), the MCP
 * tools (`promote_to_roadmap`, `add_to_roadmap` with a solution) and Building
 * auto-sync all call this, so they share the same idempotence (one ACTIVE item
 * per solution), the same defaults (squad, key result and title inherited from
 * the solution, a suggested non-overlapping slot, six weeks unless an effort is
 * known) and the same provenance (`createdById`, `source`, `autoCreated`).
 */
import { createHash } from "node:crypto";
import type { AppPrismaClient } from "@/lib/db";
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations";
import { inclusiveDayCount } from "@/lib/roadmap-timeline/calendar-geometry";
import {
  durationDaysFor,
  horizonFloor,
  horizonForStart,
  rangeFromStart,
  suggestSlot,
  type CalendarDate,
  type ScheduleHorizon,
  type SlotRange,
} from "@/lib/roadmap/scheduling";

type CaptureSource = Parameters<typeof captureWorkspaceMutation>[3];
export type RoadmapCreateHorizon = ScheduleHorizon | "SHIPPED";

export type SolutionScheduleRequest = {
  solutionId: string;
  /** Explicit horizon. When omitted it follows the slot's start date. */
  horizon?: RoadmapCreateHorizon;
  /** `undefined` inherits the opportunity's squad; `null` means no squad. */
  squadId?: string | null;
  startDate?: CalendarDate;
  endDate?: CalendarDate;
  /** Overrides the default duration when no explicit range is given. */
  durationDays?: number;
  isPrivate?: boolean;
  /** Caller-supplied overrides (MCP `add_to_roadmap`); each defaults to what the solution provides. */
  title?: string;
  description?: string | null;
  keyResultId?: string | null;
  opportunityId?: string | null;
  /** Fixed primary key, used for idempotent retries and for auto-created items. */
  id?: string;
};

export type CreateContext = {
  workspaceId: string;
  /** Stored on the row's `source` column. */
  source: string;
  captureSource: CaptureSource;
  /** Who created the items. */
  userId?: string | null;
  /** UTC calendar date to treat as today. Defaults to the server's current UTC date. */
  today?: CalendarDate;
  autoCreated?: boolean;
};

export type CreatedRoadmapItem = {
  id: string;
  workspaceId: string;
  solutionId: string | null;
  title: string;
  horizon: string;
  squadId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  autoCreated: boolean | null;
};
export type CreateFromSolutionsResult = {
  created: CreatedRoadmapItem[];
  /** Solutions that already had an ACTIVE roadmap item; nothing was created for them. */
  existing: Array<{ solutionId: string; itemId: string }>;
  /** Requested solutions that are missing from this workspace. */
  missing: string[];
  /** Requests skipped because their fixed id already exists (an earlier auto-add or retry). */
  conflicts: string[];
};

export function utcToday(now = new Date()): CalendarDate {
  return now.toISOString().slice(0, 10);
}

/** UUIDv5-style id derived from a name, stable across processes. */
export function deterministicUuid(namespace: string, name: string): string {
  const bytes = createHash("sha1").update(`${namespace}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The primary key of the roadmap item auto-sync creates for a solution. Using a
 * fixed key makes "create at most once, ever" a database guarantee: even if two
 * status changes race, or the item was later archived, the second insert
 * conflicts instead of adding a duplicate or resurrecting a removed item.
 */
export function autoRoadmapItemId(solutionId: string): string {
  return deterministicUuid("compass:roadmap-auto-sync", solutionId);
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

function toCalendarDate(value: Date): CalendarDate {
  return value.toISOString().slice(0, 10);
}

function validateRange(start: CalendarDate, end: CalendarDate): void {
  // inclusiveDayCount throws a RangeError for malformed dates or end < start.
  try {
    inclusiveDayCount(start, end);
  } catch {
    throw new Error("Roadmap dates must be an inclusive range with start on or before end");
  }
}

export async function createRoadmapItemsFromSolutions(
  prisma: AppPrismaClient,
  context: CreateContext,
  requests: readonly SolutionScheduleRequest[],
): Promise<CreateFromSolutionsResult> {
  const { workspaceId } = context;
  const today = context.today ?? utcToday();
  const result: CreateFromSolutionsResult = { created: [], existing: [], missing: [], conflicts: [] };
  // First request wins when a caller lists the same solution twice.
  const unique = [...new Map(requests.map((request) => [request.solutionId, request])).values()];
  if (unique.length === 0) return result;

  const solutionIds = unique.map((request) => request.solutionId);
  const [solutions, activeLinked, dated, squads] = await Promise.all([
    prisma.solution.findMany({
      where: { id: { in: solutionIds }, workspaceId },
      select: { id: true, title: true, opportunityId: true, opportunity: { select: { id: true, squadId: true, linkedKeyResultId: true } } },
    }),
    prisma.roadmapItem.findMany({
      where: { workspaceId, status: "ACTIVE", solutionId: { in: solutionIds } },
      select: { id: true, solutionId: true },
    }),
    prisma.roadmapItem.findMany({
      where: { workspaceId, status: "ACTIVE", startDate: { not: null }, endDate: { not: null } },
      select: { squadId: true, startDate: true, endDate: true },
    }),
    prisma.squad.findMany({ where: { workspaceId }, select: { id: true } }),
  ]);
  const solutionsById = new Map(solutions.map((solution) => [solution.id, solution]));
  const activeBySolution = new Map(activeLinked.map((item) => [item.solutionId as string, item.id]));
  const squadIds = new Set(squads.map((squad) => squad.id));

  // Occupied ranges per squad, extended as this batch places items so a batch
  // never overlaps itself.
  const occupied = new Map<string, SlotRange[]>();
  const occupiedKey = (squadId: string | null) => squadId ?? "__none__";
  for (const row of dated) {
    const key = occupiedKey(row.squadId);
    occupied.set(key, [...(occupied.get(key) ?? []), { start: toCalendarDate(row.startDate as Date), end: toCalendarDate(row.endDate as Date) }]);
  }

  for (const request of unique) {
    const solution = solutionsById.get(request.solutionId);
    if (!solution) {
      result.missing.push(request.solutionId);
      continue;
    }
    const existingId = activeBySolution.get(solution.id);
    if (existingId) {
      result.existing.push({ solutionId: solution.id, itemId: existingId });
      continue;
    }

    const squadId = request.squadId === undefined ? (solution.opportunity.squadId ?? null) : request.squadId;
    if (squadId && !squadIds.has(squadId)) throw new Error("Related record not found");

    // Shipped work is history, not a plan: without explicit dates it stays undated.
    let range: SlotRange | null;
    if (request.horizon === "SHIPPED" && !request.startDate) {
      range = null;
    } else if (request.startDate && request.endDate) {
      validateRange(request.startDate, request.endDate);
      range = { start: request.startDate, end: request.endDate };
    } else if (request.startDate) {
      range = rangeFromStart(request.startDate, request.durationDays ?? durationDaysFor(null));
    } else {
      const notBefore = request.horizon && request.horizon !== "SHIPPED" ? horizonFloor(request.horizon, today) : today;
      range = suggestSlot({
        occupied: occupied.get(occupiedKey(squadId)) ?? [],
        durationDays: request.durationDays ?? durationDaysFor(null),
        notBefore,
      });
    }
    const horizon: RoadmapCreateHorizon = request.horizon ?? (range ? horizonForStart(range.start, today) : "NOW");
    // Both ends were validated above, so these are well-formed UTC midnights.
    const startDate = range ? new Date(`${range.start}T00:00:00.000Z`) : undefined;
    const endDate = range ? new Date(`${range.end}T00:00:00.000Z`) : undefined;

    try {
      const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", context.captureSource, undefined, async (tx) => {
        const last = await tx.roadmapItem.findFirst({
          where: { workspaceId, horizon, status: "ACTIVE" },
          orderBy: [{ sortOrder: "desc" }, { id: "desc" }],
          select: { sortOrder: true },
        });
        return tx.roadmapItem.create({
          data: {
            ...(request.id ? { id: request.id } : {}),
            workspaceId,
            title: request.title ?? solution.title,
            description: request.description ?? null,
            horizon,
            sortOrder: last ? last.sortOrder + 1 : 0,
            solutionId: solution.id,
            opportunityId: request.opportunityId === undefined ? solution.opportunity.id : request.opportunityId,
            keyResultId: request.keyResultId === undefined ? (solution.opportunity.linkedKeyResultId ?? null) : request.keyResultId,
            squadId,
            startDate,
            endDate,
            isPrivate: request.isPrivate ?? false,
            source: context.source,
            createdById: context.userId ?? null,
            updatedById: context.userId ?? null,
            autoCreated: context.autoCreated ? true : null,
          },
        });
      });
      if (range) {
        const key = occupiedKey(squadId);
        occupied.set(key, [...(occupied.get(key) ?? []), range]);
      }
      activeBySolution.set(solution.id, item.id);
      result.created.push({
        id: item.id,
        workspaceId: item.workspaceId,
        solutionId: item.solutionId,
        title: item.title,
        horizon: item.horizon,
        squadId: item.squadId,
        startDate: item.startDate,
        endDate: item.endDate,
        autoCreated: item.autoCreated ?? null,
      });
    } catch (error) {
      if (request.id && isUniqueConflict(error)) {
        result.conflicts.push(solution.id);
        continue;
      }
      throw error;
    }
  }
  return result;
}

