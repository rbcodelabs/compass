/**
 * Pure scheduling rules for building the roadmap from Discovery.
 *
 * Everything here is deterministic and free of I/O so the same logic can run in
 * the browser (previews, the command palette's suggested slot) and on the
 * server (the authoritative create path used by the UI, MCP and auto-sync).
 * Dates are `YYYY-MM-DD` calendar dates and every range is inclusive, matching
 * the native timeline.
 */
import { addCalendarDays, calendarDateToUtcMilliseconds, inclusiveDayCount, type CalendarDate } from "@/lib/roadmap-timeline/calendar-geometry";

export type { CalendarDate };
export type ScheduleHorizon = "NOW" | "NEXT" | "LATER";
export type SlotRange = { start: CalendarDate; end: CalendarDate };

/** Used when a solution carries no effort estimate. */
export const DEFAULT_DURATION_DAYS = 42;
const MIN_DURATION_DAYS = 7;
const MAX_DURATION_DAYS = 365;
const DAY_MS = 86_400_000;

/** Where each horizon begins, measured in days from today. */
export const HORIZON_START_OFFSET_DAYS: Readonly<Record<ScheduleHorizon, number>> = { NOW: 0, NEXT: 56, LATER: 112 };

/** The squad key used for items with no squad, so they share one lane. */
const NO_SQUAD_KEY = "__none__";

export function durationDaysFor(effortWeeks?: number | null): number {
  if (typeof effortWeeks !== "number" || !Number.isFinite(effortWeeks) || effortWeeks <= 0) return DEFAULT_DURATION_DAYS;
  return Math.min(MAX_DURATION_DAYS, Math.max(MIN_DURATION_DAYS, Math.round(effortWeeks * 7)));
}

export function rangeFromStart(start: CalendarDate, durationDays: number): SlotRange {
  return { start, end: addCalendarDays(start, Math.max(1, durationDays) - 1) };
}

function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((calendarDateToUtcMilliseconds(to) - calendarDateToUtcMilliseconds(from)) / DAY_MS);
}

/** The Now / Next / Later bucket an item starting on `start` belongs to. */
export function horizonForStart(start: CalendarDate, today: CalendarDate): ScheduleHorizon {
  const offset = daysBetween(today, start);
  if (offset >= HORIZON_START_OFFSET_DAYS.LATER) return "LATER";
  if (offset >= HORIZON_START_OFFSET_DAYS.NEXT) return "NEXT";
  return "NOW";
}

/** The earliest date a horizon's items should start on. */
export function horizonFloor(horizon: ScheduleHorizon, today: CalendarDate): CalendarDate {
  return addCalendarDays(today, HORIZON_START_OFFSET_DAYS[horizon]);
}

/**
 * The first slot of `durationDays` on or after `notBefore` that does not overlap
 * any occupied range. Gaps between items are used only when the whole duration
 * fits.
 */
export function suggestSlot({ occupied, durationDays, notBefore }: { occupied: readonly SlotRange[]; durationDays: number; notBefore: CalendarDate }): SlotRange {
  const sorted = [...occupied].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  let cursor = notBefore;
  for (const range of sorted) {
    if (range.end < cursor) continue;
    if (range.start > cursor && daysBetween(cursor, range.start) >= durationDays) break;
    cursor = addCalendarDays(range.end, 1);
  }
  return rangeFromStart(cursor, durationDays);
}

export type BatchCandidate = { solutionId: string; squadId: string | null; score: number | null; durationDays: number };
export type BatchProposal = BatchCandidate & SlotRange & { horizon: ScheduleHorizon };

/**
 * Greedy proposal for many solutions at once: highest score first, each placed
 * in the first free slot of its squad's row at or after today, never
 * overlapping the squad's existing items or earlier proposals.
 */
export function proposeBatch({ candidates, existing, today, notBefore = today }: {
  candidates: readonly BatchCandidate[];
  existing: ReadonlyArray<SlotRange & { squadId: string | null }>;
  today: CalendarDate;
  notBefore?: CalendarDate;
}): BatchProposal[] {
  const occupiedBySquad = new Map<string, SlotRange[]>();
  for (const item of existing) {
    const key = item.squadId ?? NO_SQUAD_KEY;
    occupiedBySquad.set(key, [...(occupiedBySquad.get(key) ?? []), { start: item.start, end: item.end }]);
  }
  const ordered = [...candidates].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.solutionId.localeCompare(b.solutionId));
  const floor = notBefore < today ? today : notBefore;
  return ordered.map((candidate) => {
    const key = candidate.squadId ?? NO_SQUAD_KEY;
    const occupied = occupiedBySquad.get(key) ?? [];
    const slot = suggestSlot({ occupied, durationDays: candidate.durationDays, notBefore: floor });
    occupiedBySquad.set(key, [...occupied, slot]);
    return { ...candidate, ...slot, horizon: horizonForStart(slot.start, today) };
  });
}

export type AutoAddInput = {
  previousStatus: string | null;
  status: string;
  /** An ACTIVE roadmap item already links this solution. */
  hasActiveItem: boolean;
  /** An auto-created item for this solution was removed or undone earlier. */
  hasAutoTombstone: boolean;
};
export type AutoAddPlan = { create: true } | { create: false; reason: "not-building" | "no-transition" | "already-scheduled" | "suppressed" };

/** The solution status that triggers auto-add. Validated stays in the rail on purpose. */
export const AUTO_ADD_STATUS = "IN_DELIVERY";

export function planAutoAdd(input: AutoAddInput): AutoAddPlan {
  if (input.status !== AUTO_ADD_STATUS) return { create: false, reason: "not-building" };
  if (input.previousStatus === AUTO_ADD_STATUS) return { create: false, reason: "no-transition" };
  if (input.hasActiveItem) return { create: false, reason: "already-scheduled" };
  if (input.hasAutoTombstone) return { create: false, reason: "suppressed" };
  return { create: true };
}

export type LinkedSyncInput = {
  item: { title: string; horizon: string; startDate: CalendarDate | null; endDate: CalendarDate | null; scheduleEdited: boolean };
  today: CalendarDate;
  change: { previousTitle?: string; title?: string; previousStatus?: string | null; status?: string };
};
export type LinkedSyncPatch = { title?: string; horizon?: string; startDate?: CalendarDate; endDate?: CalendarDate };

/**
 * How a linked roadmap item follows its solution. Titles follow until a human
 * renames the item; status (horizon) and dates follow until a human edits the
 * schedule. Returns null when nothing should change.
 */
export function planLinkedSync({ item, today, change }: LinkedSyncInput): LinkedSyncPatch | null {
  const patch: LinkedSyncPatch = {};
  if (change.title !== undefined && change.previousTitle !== undefined && change.title !== change.previousTitle && item.title === change.previousTitle) {
    patch.title = change.title;
  }
  const transitioned = change.status !== undefined && change.status !== change.previousStatus;
  if (transitioned && !item.scheduleEdited) {
    if (change.status === "IN_DELIVERY") {
      if (item.horizon === "NEXT" || item.horizon === "LATER") patch.horizon = "NOW";
      if (item.startDate && item.endDate && item.startDate > today) {
        patch.startDate = today;
        patch.endDate = addCalendarDays(today, inclusiveDayCount(item.startDate, item.endDate) - 1);
      }
    } else if (change.status === "SHIPPED") {
      if (item.horizon === "NOW" || item.horizon === "NEXT" || item.horizon === "LATER") patch.horizon = "SHIPPED";
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
