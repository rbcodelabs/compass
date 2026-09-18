import { HORIZON_META, HORIZON_ORDER } from "@/lib/roadmap";
import type { Horizon, SelectOption } from "@/lib/types";
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
import { NO_PRIMARY_GROUP_KEY } from "@/lib/roadmap-timeline/lane-packing";
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
  /**
   * The horizon a drop onto this row should assign to an item, and the axis
   * `isBacklogCompatibleWithRow`/`isInternalTimelineDestination` reason
   * about. Only Phase-grouping rows carry one — every other grouping mode's
   * rows span every horizon at once, so there is no single horizon a drop
   * onto them could mean. `handleDragEnd` falls back to the dragged item's
   * own (unchanged) horizon when this is null — see the "disable
   * drag-to-regroup" behavior in native-timeline.tsx.
   */
  horizon: Horizon | null;
  squadId: string | null;
  color: string | null;
  /**
   * The id of the primary group (see `TimelineGrouping`) this row belongs
   * to — a horizon code in Phase mode, a squad id (or `NO_SQUAD_GROUP_ID`)
   * in Squad mode, a custom-field option's synthetic group id (or
   * `NO_FIELD_VALUE_GROUP_ID`) in Custom-field mode, or the reserved
   * `NO_PRIMARY_GROUP_KEY` sentinel in None mode. Used to match an item to
   * its row without re-deriving the mapping from `horizon`.
   */
  primaryId: string;
};

export const dateToPosition = dateToTimelinePosition;
export const positionToInclusiveDate = positionToInclusiveCalendarDate;
export const clampRange = clampTimelineRange;
export const resizeRange = resizeTimelineRange;

export function pointerClientToCanvasPosition(clientX: number, canvasLeft: number): number {
  return clientX - canvasLeft;
}

/**
 * A configurable-grouping "header" bucket — one row of `PrimaryGroup`s
 * becomes one header row (plus its secondary lanes) in `buildTimelineRows`.
 */
export type PrimaryGroup = {
  id: string;
  label: string;
  color: string | null;
  /** Set only for Phase grouping's horizon-derived groups. */
  horizon: Horizon | null;
};

/** The subset of a timeline item a grouping's `primaryOf` resolver needs. */
export type TimelineGroupingItem = { id: string; horizon: Horizon; squad: { id: string } | null };

export type TimelineGrouping = {
  /** Header rows in display order, or `null` for "no header rows" (None mode). */
  primaryGroups: PrimaryGroup[] | null;
  /** True when squad itself is the primary axis (Squad mode) — collapses each header to one lane instead of per-squad sub-lanes. */
  squadIsPrimary: boolean;
  /** Maps an item to the id of the `PrimaryGroup` it belongs to. Not called when `primaryGroups` is null. */
  primaryOf: (item: TimelineGroupingItem) => string | null;
  /** Left-column axis heading, e.g. "Horizon → Squad", "Squad", or "<Field name> → Squad". */
  axisLabel: string;
};

/** Synthetic "No squad" header group id in Squad grouping. Never collides with a real squad id (a cuid). */
export const NO_SQUAD_GROUP_ID = "no-squad";
/** Synthetic "No value" header group id in Custom-field grouping. Never collides with a synthesized `opt-<index>` id. */
export const NO_FIELD_VALUE_GROUP_ID = "no-value";

/**
 * The default, and today's only, grouping: header rows are the roadmap
 * horizons in `HORIZON_ORDER`, and every header's secondary lanes are the
 * workspace's squads. `buildTimelineRows(squads)` (no grouping argument)
 * uses this, which is what keeps the default path byte-identical to the
 * pre-generalization implementation.
 */
export const PHASE_GROUPING: TimelineGrouping = {
  primaryGroups: HORIZON_ORDER.map((horizon) => ({
    id: horizon,
    label: HORIZON_META[horizon].label,
    color: HORIZON_META[horizon].color,
    horizon,
  })),
  squadIsPrimary: false,
  primaryOf: (item) => item.horizon,
  axisLabel: "Horizon → Squad",
};

/** Squad grouping: one header + single lane per squad, plus a trailing "No squad" group. No secondary axis. */
export function buildSquadGrouping(squads: Array<{ id: string; name: string; color: string }>): TimelineGrouping {
  const ordered = [...squads].sort((a, b) => a.name.localeCompare(b.name));
  return {
    primaryGroups: [
      ...ordered.map((squad) => ({ id: squad.id, label: squad.name, color: squad.color, horizon: null })),
      { id: NO_SQUAD_GROUP_ID, label: "No squad", color: null, horizon: null },
    ],
    squadIsPrimary: true,
    primaryOf: (item) => item.squad?.id ?? NO_SQUAD_GROUP_ID,
    axisLabel: "Squad",
  };
}

/** No grouping at all: no header rows, one flat set of squad lanes across every horizon. */
export const NONE_GROUPING: TimelineGrouping = {
  primaryGroups: null,
  squadIsPrimary: false,
  primaryOf: () => null,
  axisLabel: "Squad",
};

/**
 * Custom-field grouping: one header per the field's resolved SELECT option
 * (in definition order) plus a trailing "No value" group, each with squad
 * sub-lanes — the same shape as Phase grouping, just with a different header
 * axis. `valuesByItemId` is the batch-loaded `CustomFieldValue.value` per
 * roadmap item (see lib/custom-field-values-batch.ts); only bare-string
 * (SELECT) values are honored, matching the "SELECT only, not MULTI_SELECT"
 * grouping scope.
 */
export function buildCustomFieldGrouping(
  field: { id: string; name: string; options: SelectOption[] | null },
  valuesByItemId: Readonly<Record<string, unknown>>,
): TimelineGrouping {
  const options = field.options ?? [];
  const groupIdByValue = new Map(options.map((option, index) => [option.value, `opt-${index}`]));
  return {
    primaryGroups: [
      ...options.map((option, index) => ({ id: `opt-${index}`, label: option.label, color: option.color ?? null, horizon: null })),
      { id: NO_FIELD_VALUE_GROUP_ID, label: "No value", color: null, horizon: null },
    ],
    squadIsPrimary: false,
    primaryOf: (item) => {
      const raw = valuesByItemId[item.id];
      const value = typeof raw === "string" ? raw : null;
      return (value !== null && groupIdByValue.get(value)) || NO_FIELD_VALUE_GROUP_ID;
    },
    axisLabel: `${field.name} → Squad`,
  };
}

export function buildTimelineRows(
  squads: Array<{ id: string; name: string; color: string }>,
  grouping: TimelineGrouping = PHASE_GROUPING,
): TimelineRow[] {
  const orderedSquads = [...squads].sort((a, b) => a.name.localeCompare(b.name));
  if (grouping.primaryGroups === null) {
    return buildSecondarySquadLanes(NO_PRIMARY_GROUP_KEY, orderedSquads, null);
  }
  return grouping.primaryGroups.flatMap((group) => [
    // The `horizon:` id prefix predates configurable grouping and is kept
    // literally (rather than renamed to e.g. `header:`) so Phase mode's row
    // ids — and therefore its default rendered output — stay byte-identical.
    { id: `horizon:${group.id}`, kind: "horizon" as const, label: group.label, horizon: group.horizon, squadId: null, color: group.color, primaryId: group.id },
    ...(grouping.squadIsPrimary
      ? [{
          id: `lane:${group.id}:__self__`,
          kind: "lane" as const,
          label: group.label,
          horizon: group.horizon,
          squadId: group.id === NO_SQUAD_GROUP_ID ? null : group.id,
          color: group.color,
          primaryId: group.id,
        }]
      : buildSecondarySquadLanes(group.id, orderedSquads, group.horizon)),
  ]);
}

function buildSecondarySquadLanes(
  primaryId: string,
  orderedSquads: Array<{ id: string; name: string; color: string }>,
  horizon: Horizon | null,
): TimelineRow[] {
  return [
    ...orderedSquads.map((squad) => ({ id: `lane:${primaryId}:${squad.id}`, kind: "lane" as const, label: squad.name, horizon, squadId: squad.id, color: squad.color, primaryId })),
    { id: `lane:${primaryId}:unassigned`, kind: "lane" as const, label: "No squad", horizon, squadId: null, color: null, primaryId },
  ];
}

/**
 * The `{primaryId, secondaryId}` a given item resolves to under a grouping —
 * the same pair both a matching `TimelineRow` (its `primaryId`/`squadId`)
 * and `createTimelineLaneKey` are keyed by. Used to find an item's row and
 * to build its packing lane key with one shared derivation.
 */
export function timelineLaneParts(grouping: TimelineGrouping, item: TimelineGroupingItem): { primaryId: string; secondaryId: string | null } {
  if (grouping.primaryGroups === null) {
    return { primaryId: NO_PRIMARY_GROUP_KEY, secondaryId: item.squad?.id ?? null };
  }
  const primaryId = grouping.primaryOf(item) ?? NO_PRIMARY_GROUP_KEY;
  return { primaryId, secondaryId: grouping.squadIsPrimary ? null : (item.squad?.id ?? null) };
}

export function isBacklogCompatibleWithRow(
  item: { kind: "solution"; squadId: string | null } | { kind: "feedback" },
  row: TimelineRow,
): row is TimelineRow & { horizon: Horizon } {
  if (row.kind !== "lane" || row.horizon === null || !NATIVE_BACKLOG_HORIZONS.includes(row.horizon)) return false;
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
