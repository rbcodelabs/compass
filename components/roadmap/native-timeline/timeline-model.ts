import { HORIZON_META, getInternalBoardHorizons } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";
import {
  addCalendarDays,
  calendarDateToUtcMilliseconds,
  clampTimelineRange,
  dateToTimelinePosition,
  inclusiveDayCount,
  positionToInclusiveCalendarDate,
  resizeTimelineRange,
  timelinePixelDeltaToDays,
  type CalendarDate,
} from "@/lib/roadmap-timeline/calendar-geometry";
import {
  calculateTimelineRenderWindow,
  selectTimelineIntervalsForRender,
} from "@/lib/roadmap-timeline/virtualization";

export { addCalendarDays, calculateTimelineRenderWindow, inclusiveDayCount, selectTimelineIntervalsForRender, timelinePixelDeltaToDays };
export type { CalendarDate };
export type TimelineZoom = "month" | "quarter";
export const NATIVE_BACKLOG_HORIZONS: readonly Horizon[] = ["NOW", "NEXT", "LATER"];
export const NATIVE_INTERNAL_DESTINATIONS: readonly Horizon[] = ["NOW", "NEXT", "LATER", "SHIPPED"];

export type TimelineRow = {
  id: string;
  kind: "horizon" | "lane";
  label: string;
  horizon: Horizon;
  squadId: string | null;
  color: string | null;
};

export const dateToPosition = dateToTimelinePosition;
export const positionToInclusiveDate = positionToInclusiveCalendarDate;
export const clampRange = clampTimelineRange;
export const resizeRange = resizeTimelineRange;

export function pointerClientToCanvasPosition(clientX: number, canvasLeft: number): number {
  return clientX - canvasLeft;
}

export function buildTimelineRows(
  squads: Array<{ id: string; name: string; color: string }>,
  launchWorkflowEnabled: boolean = true
): TimelineRow[] {
  const orderedSquads = [...squads].sort((a, b) => a.name.localeCompare(b.name));
  return getInternalBoardHorizons(launchWorkflowEnabled).flatMap((horizon) => [
    { id: `horizon:${horizon}`, kind: "horizon" as const, label: HORIZON_META[horizon].label, horizon, squadId: null, color: HORIZON_META[horizon].color },
    ...orderedSquads.map((squad) => ({ id: `lane:${horizon}:${squad.id}`, kind: "lane" as const, label: squad.name, horizon, squadId: squad.id, color: squad.color })),
    { id: `lane:${horizon}:unassigned`, kind: "lane" as const, label: "No squad", horizon, squadId: null, color: null },
  ]);
}

export function isBacklogCompatibleWithRow(item: { kind: "solution"; squadId: string | null } | { kind: "feedback" }, row: TimelineRow): boolean {
  if (row.kind !== "lane" || !NATIVE_BACKLOG_HORIZONS.includes(row.horizon)) return false;
  return item.kind === "solution" ? row.squadId === item.squadId : row.squadId === null;
}

export function isInternalTimelineDestination(source: Horizon, destination: Horizon): boolean {
  if (source === "LAUNCHING" || source === "LAUNCHED") return false;
  return source === destination || NATIVE_INTERNAL_DESTINATIONS.includes(destination);
}

export function utcDate(date: CalendarDate): Date {
  return new Date(calendarDateToUtcMilliseconds(date));
}

export function monthStart(date: CalendarDate): CalendarDate {
  const value = new Date(calendarDateToUtcMilliseconds(date));
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const value = new Date(calendarDateToUtcMilliseconds(date));
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1)).toISOString().slice(0, 10);
}
