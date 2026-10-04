"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from "react";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { RoadmapHeader } from "../roadmap-header";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";
import type { SelectOption } from "@/lib/types";
import { GripVertical } from "lucide-react";
import { createTimelineLaneKey, packTimelineIntervals } from "@/lib/roadmap-timeline/lane-packing";
import { HORIZON_META, HORIZON_ORDER } from "@/lib/roadmap";
import { parseUnscheduledDragId, type UnscheduledItem } from "../unscheduled-items-panel";
import { ScheduleRail, type BulkPlacement, type SolutionRailItem } from "../schedule/schedule-rail";
import { SchedulePalette, type PaletteDates } from "../schedule/schedule-palette";
import { RangeSchedulePopover } from "../schedule/range-schedule-popover";
import { BuildFromDiscovery } from "../schedule/build-from-discovery";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { pushUndoToast } from "@/lib/ui/undo-toast";
import { durationDaysFor, suggestSlot, type SlotRange } from "@/lib/roadmap/scheduling";
import { type CatalogSolution, type ScheduleCatalog } from "@/lib/roadmap/rail";
import {
  addCalendarDays,
  addCalendarMonths,
  buildCustomFieldGrouping,
  buildPhaseGrouping,
  buildSquadGrouping,
  buildTimelineRows,
  calculateTimelineRenderWindow,
  dateToPosition,
  inclusiveDayCount,
  isBacklogCompatibleWithRow,
  isInternalTimelineDestination,
  NONE_GROUPING,
  pointerClientToCanvasPosition,
  positionToInclusiveDate,
  resizeRange,
  selectTimelineIntervalsForRender,
  solutionDropTarget,
  timelineLaneParts,
  timelinePixelDeltaToDays,
  type CalendarDate,
  type TimelineGrouping,
  type TimelineRow,
} from "./timeline-model";
import { EditDatesDialog, TimelineCard, useTimelinePanelNavigation, type TimelineEngineProps } from "./timeline-shared";
import { localCalendarToday, useTimelineController, type TimelineItemView } from "./use-timeline-controller";

const LABEL_WIDTH = 176;
const HEADER_HEIGHT = 72;
const HORIZON_HEIGHT = 34;
const LANE_HEIGHT = 50;
// Very short bars retain one 44px schedule-dialog target. Wider bars keep
// four separate 24px targets inside their exact date geometry.
const MIN_INTERACTION_WIDTH = 44;
// Four 24px controls, a 24px details target, and the card's two borders.
const MIN_INLINE_WIDTH = 122;

type NativeItemLayout = {
  item: TimelineItemView;
  left: number;
  width: number;
  interactionWidth: number;
  top: number;
  track: number;
  trackCount: number;
  overlapCount: number;
};

const EMPTY_CATALOG: ScheduleCatalog = { solutions: [], opportunities: [], scheduledSolutionIds: [] };
/** Pointer travel below this is a click, not a drawn range. */
const MIN_RANGE_DRAG_PX = 12;

type DropGhost = { rowId: string; start: CalendarDate; end: CalendarDate; title: string };
type RangeDraft = { rowId: string; startX: number; currentX: number };
type RangePopoverState = { anchor: { x: number; y: number }; rowId: string; start: CalendarDate; end: CalendarDate };

/** True while the user is typing: the `/` shortcut must never steal a keystroke. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = target.getAttribute("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

function formatShortDay(date: CalendarDate): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

export function NativeTimeline(props: TimelineEngineProps & {
  headerSquads?: TimelineEngineProps["squads"];
  cardSortHref?: string;
  customFieldGroups?: CustomFieldFilterGroup[];
  activeCustomFieldId?: string | null;
  /** Row grouping mode. Defaults to "phase" — today's only behavior. */
  groupBy?: "phase" | "squad" | "none" | "customField";
  /** Required (and only consulted) when groupBy is "customField". */
  groupByField?: { id: string; name: string; options: SelectOption[] } | null;
  /** Batch-loaded CustomFieldValue.value per roadmap item id, for "customField" grouping. */
  customFieldValuesByItemId?: Record<string, unknown>;
  /** Every groupable (SELECT-type ROADMAP_ITEM) custom field, for the grouping toggle's option list — independent of which one (if any) is currently active. */
  groupByOptions?: { id: string; label: string }[];
  /** Every live solution and opportunity, for the schedule palette, the empty-roadmap presets and Undo. */
  scheduleCatalog?: ScheduleCatalog;
  /** The workspace has no ACTIVE roadmap items at all (not merely none matching the current filter). */
  roadmapEmpty?: boolean;
}) {
  const labels = useLabels();
  const controller = useTimelineController({
    initialItems: props.items,
    initialUnscheduled: props.unscheduledItems,
    workspaceId: props.workspaceId,
    initialCatalog: props.scheduleCatalog,
  });
  const catalog = props.scheduleCatalog ?? EMPTY_CATALOG;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [ghost, setGhost] = useState<DropGhost | null>(null);
  const [rangeDraft, setRangeDraft] = useState<RangeDraft | null>(null);
  const [rangePopover, setRangePopover] = useState<RangePopoverState | null>(null);
  const launchWorkflowEnabled = props.launchWorkflowEnabled ?? true;
  const grouping: TimelineGrouping = useMemo(() => {
    if (props.groupBy === "squad") return buildSquadGrouping(props.squads);
    if (props.groupBy === "none") return NONE_GROUPING;
    if (props.groupBy === "customField" && props.groupByField) return buildCustomFieldGrouping(props.groupByField, props.customFieldValuesByItemId ?? {});
    return buildPhaseGrouping(launchWorkflowEnabled);
  }, [props.groupBy, props.groupByField, props.customFieldValuesByItemId, props.squads, launchWorkflowEnabled]);
  const rows = useMemo(() => buildTimelineRows(props.squads, grouping), [props.squads, grouping]);
  // The value the header's grouping Select should show as selected — the
  // active custom field's id in "customField" mode, else the mode literal.
  const groupByValue = props.groupBy === "customField" ? (props.groupByField?.id ?? "phase") : (props.groupBy ?? "phase");
  // Per-item custom-field-value badges, shown on cards only while grouping by
  // that field — there is no other surface on the timeline that shows a
  // custom field value today, so without this the grouping itself would be
  // illegible per item (only visible from which header an item sits under).
  const customFieldBadgeByItemId = useMemo(() => {
    if (props.groupBy !== "customField" || !props.groupByField) return null;
    const optionByValue = new Map(props.groupByField.options.map((option) => [option.value, option]));
    const values = props.customFieldValuesByItemId ?? {};
    const badges = new Map<string, { label: string; color: string | null }>();
    for (const item of controller.items) {
      const raw = values[item.id];
      const option = typeof raw === "string" ? optionByValue.get(raw) : undefined;
      if (option) badges.set(item.id, { label: option.label, color: option.color ?? null });
    }
    return badges;
  }, [controller.items, props.groupBy, props.groupByField, props.customFieldValuesByItemId]);
  const dayWidth = controller.zoom === "month" ? 12 : 4;
  const timelineWidth = inclusiveDayCount(controller.viewportStart, addCalendarDays(controller.viewportEnd, -1)) * dayWidth;
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragPointerCurrentX = useRef<number | null>(null);
  const dragPointerCleanup = useRef<(() => void) | null>(null);
  const [scrollViewport, setScrollViewport] = useState({ scrollLeft: 0, width: 0 });
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimelineItemView | null>(null);
  const { openItem, triggerItemId } = useTimelinePanelNavigation();
  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const gridRef = useRef<HTMLDivElement>(null);
  const rangeDraftRef = useRef<RangeDraft | null>(null);

  const autoAdded = useMemo(
    () => controller.items.filter((item) => item.autoCreated).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [controller.items],
  );

  const packedItems = useMemo(() => packTimelineIntervals(controller.items.map((item) => {
    const { primaryId, secondaryId } = timelineLaneParts(grouping, item);
    return {
      item,
      id: item.id,
      laneKey: createTimelineLaneKey(primaryId, secondaryId),
      start: item.viewStart,
      end: addCalendarDays(item.viewEnd, Math.max(0, Math.ceil(MIN_INTERACTION_WIDTH / dayWidth) - inclusiveDayCount(item.viewStart, item.viewEnd))),
    };
  })), [controller.items, dayWidth, grouping]);
  const laneTrackCounts = useMemo(() => new Map(packedItems.map((item) => [item.laneKey, item.trackCount])), [packedItems]);
  const rowHeights = useMemo(() => new Map(rows.map((row) => [
    row.id,
    row.kind === "horizon"
      ? HORIZON_HEIGHT
      // In Squad grouping (squadIsPrimary), an item's own lane key always
      // carries a null secondary id (see timelineLaneParts) even though the
      // row's own squadId is set (needed for the cross-squad drop guard) —
      // match that here, or Squad mode's rows would never find their track
      // counts.
      : Math.max(LANE_HEIGHT, 14 + (laneTrackCounts.get(createTimelineLaneKey(row.primaryId, grouping.squadIsPrimary ? null : row.squadId)) ?? 1) * 36),
  ])), [grouping.squadIsPrimary, laneTrackCounts, rows]);
  const rowTops = useMemo(() => {
    let top = 0;
    return new Map(rows.map((row) => {
      const entry: [string, number] = [row.id, top];
      top += rowHeights.get(row.id) ?? LANE_HEIGHT;
      return entry;
    }));
  }, [rowHeights, rows]);
  const bodyHeight = rows.reduce((height, row) => height + (rowHeights.get(row.id) ?? LANE_HEIGHT), 0);

  // First free slot for a solution's squad at or after today: the same rule the server applies when no dates are sent.
  const suggestSlotFor = useCallback((solution: CatalogSolution): SlotRange => suggestSlot({
    occupied: controller.items
      .filter((item) => item.hasDates && (item.squad?.id ?? null) === solution.squadId)
      .map((item) => ({ start: item.viewStart, end: item.viewEnd })),
    durationDays: durationDaysFor(null),
    notBefore: localCalendarToday(),
  }), [controller.items]);

  async function scheduleFromPalette(solutions: CatalogSolution[], dates: PaletteDates | null) {
    const ranged = dates && solutions.length === 1;
    await controller.scheduleSolutions(solutions.map((solution) => ({
      solutionId: solution.id,
      ...(ranged ? { startDate: dates.startDate, endDate: addCalendarDays(dates.startDate, dates.weeks * 7 - 1) } : {}),
    }))).catch(() => undefined);
  }

  function scheduleFromRail(items: SolutionRailItem[], placement: BulkPlacement) {
    if (placement === "AUTO") {
      // Highest score first, each into the first free slot of its squad: a greedy fit.
      const ordered = [...items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title));
      void controller.scheduleSolutions(
        ordered.map((item) => ({ solutionId: item.id })),
        { message: `Auto-fit ${ordered.length} ${ordered.length === 1 ? "item" : "items"} by score and squad capacity` },
      ).catch(() => undefined);
      return;
    }
    void controller.scheduleSolutions(items.map((item) => ({ solutionId: item.id, horizon: placement }))).catch(() => undefined);
  }

  // `/` opens the schedule palette from anywhere on the timeline except while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target) || (event.target instanceof HTMLElement && event.target.closest("[role=dialog]"))) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    const syncViewport = () => {
      const next = { scrollLeft: scrollContainer.scrollLeft, width: scrollContainer.clientWidth };
      setScrollViewport((current) => current.scrollLeft === next.scrollLeft && current.width === next.width ? current : next);
    };
    syncViewport();
    const observer = new ResizeObserver(syncViewport);
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [timelineWidth]);

  useLayoutEffect(() => () => stopDragPointerTracking(), []);


  // The window opens two months before today, so on a typical viewport today
  // (and any undated item placed there) sits right of the first screenful and,
  // late in a month, beyond the virtualized render window. "Go to today" must
  // actually bring it into view rather than only resetting the window.
  function goToToday() {
    const windowStart = controller.jumpToday();
    const container = scrollRef.current;
    if (!windowStart || !container) return;
    const todayLeft = (inclusiveDayCount(windowStart, localCalendarToday()) - 1) * dayWidth;
    container.scrollTo({ left: Math.max(0, todayLeft - container.clientWidth / 3) });
  }

  const renderWindow = calculateTimelineRenderWindow(scrollViewport.scrollLeft, scrollViewport.width, timelineWidth);
  const itemLayouts = useMemo<NativeItemLayout[]>(() => packedItems.flatMap((packed) => {
    const item = packed.item;
    const { primaryId, secondaryId } = timelineLaneParts(grouping, item);
    // In Squad grouping (squadIsPrimary) there is exactly one lane per
    // primary group, so primaryId alone identifies it — the row's squadId
    // is set (for the cross-squad drop guard) even though secondaryId is
    // always null there.
    const row = rows.find((candidate) => candidate.kind === "lane" && candidate.primaryId === primaryId && (grouping.squadIsPrimary || candidate.squadId === secondaryId));
    if (!row) return [];
    return [{
      item,
      left: dateToPosition(item.viewStart, controller.viewportStart, controller.viewportEnd, timelineWidth),
      width: inclusiveDayCount(item.viewStart, item.viewEnd) * dayWidth,
      interactionWidth: Math.max(MIN_INTERACTION_WIDTH, inclusiveDayCount(item.viewStart, item.viewEnd) * dayWidth),
      top: (rowTops.get(row.id) ?? 0) + 7 + packed.track * 36,
      track: packed.track,
      trackCount: packed.trackCount,
      overlapCount: canonicalOverlapCount(item, controller.items),
    }];
  }).sort((left, right) => left.top - right.top
    || left.item.viewStart.localeCompare(right.item.viewStart)
    || left.item.viewEnd.localeCompare(right.item.viewEnd)
    || left.item.id.localeCompare(right.item.id)), [controller.items, controller.viewportEnd, controller.viewportStart, dayWidth, grouping, packedItems, rowTops, rows, timelineWidth]);
  const retainedItemIds = useMemo(
    () => new Set([activeItemId, focusedItemId, triggerItemId].filter((id): id is string => Boolean(id))),
    [activeItemId, focusedItemId, triggerItemId],
  );
  const renderedItemLayouts = selectTimelineIntervalsForRender(
    itemLayouts,
    renderWindow,
    (layout) => ({ id: layout.item.id, start: layout.left, end: layout.left + layout.interactionWidth }),
    retainedItemIds,
  );

  function handleDragStart(event: DragStartEvent) {
    const dragId = String(event.active.id);
    setActiveDragId(dragId);
    startDragPointerTracking(event.activatorEvent);
    setActiveItemId(dragId.startsWith("timeline:item:") ? dragId.slice("timeline:item:".length) : null);
  }

  function startDragPointerTracking(activatorEvent: Event) {
    stopDragPointerTracking();
    dragPointerCurrentX.current = clientXFromNativeEvent(activatorEvent);
    const trackPointer = (event: Event) => {
      const clientX = clientXFromNativeEvent(event);
      if (clientX !== null) dragPointerCurrentX.current = clientX;
    };
    window.addEventListener("pointermove", trackPointer, true);
    window.addEventListener("touchmove", trackPointer, true);
    dragPointerCleanup.current = () => {
      window.removeEventListener("pointermove", trackPointer, true);
      window.removeEventListener("touchmove", trackPointer, true);
    };
  }

  function stopDragPointerTracking() {
    dragPointerCleanup.current?.();
    dragPointerCleanup.current = null;
    dragPointerCurrentX.current = null;
  }

  /** The calendar date under the drag pointer, or null when it cannot be measured. */
  function dropDateUnderPointer(): CalendarDate | null {
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const pointerX = dragPointerCurrentX.current;
    if (!canvasRect || pointerX === null) return null;
    return positionToInclusiveDate(pointerClientToCanvasPosition(pointerX, canvasRect.left), controller.viewportStart, controller.viewportEnd, timelineWidth);
  }

  function handleDragEnd(event: DragEndEvent) {
    const dragId = String(event.active.id);
    if (dragId.startsWith("timeline:item:")) {
      const item = controller.items.find((candidate) => `timeline:item:${candidate.id}` === dragId);
      if (!item) return;
      const destination = rows.find((candidate) => candidate.id === event.over?.id);
      // Disable drag-to-regroup: only a Phase-mode row carries a horizon —
      // in every other grouping mode a drop only ever moves dates, so the
      // item keeps its own horizon.
      const destinationHorizon = destination?.kind === "lane" && destination.horizon !== null ? destination.horizon : item.horizon;
      if (destination?.kind === "lane" && destination.squadId !== (item.squad?.id ?? null)) {
        controller.setAnnouncement(`${item.title} cannot move to a different squad from the timeline`);
        return;
      }
      if (!isInternalTimelineDestination(item.horizon, destinationHorizon)) {
        controller.setAnnouncement(`${item.title} cannot move to ${HORIZON_META[destinationHorizon].label} from the timeline`);
        return;
      }
      if (event.delta.x === 0 && destinationHorizon === item.horizon) return;
      const days = timelinePixelDeltaToDays(event.delta.x, dayWidth);
      const range = {
        start: addCalendarDays(item.viewStart, days),
        end: addCalendarDays(item.viewEnd, days),
      };
      void controller.reschedule(item.id, destinationHorizon, range.start, range.end).catch(() => undefined);
      return;
    }

    const parsed = parseUnscheduledDragId(dragId);
    const row = rows.find((candidate) => candidate.id === event.over?.id);
    const backlogItem = parsed
      ? controller.unscheduled.find((candidate) => candidate.id === parsed.id && candidate.kind === parsed.kind)
      : undefined;
    if (backlogItem?.kind === "solution") {
      // A rail card dropped on a row creates a linked roadmap item: the row's squad, the date under the pointer, the default length.
      const target = row ? solutionDropTarget(row) : null;
      const dropDate = dropDateUnderPointer();
      if (!row || !target || !dropDate) {
        controller.setAnnouncement(`${backlogItem.title} cannot be scheduled in that lane`);
        return;
      }
      const end = addCalendarDays(dropDate, durationDaysFor(null) - 1);
      void controller.scheduleSolutions([{
        solutionId: backlogItem.id,
        horizon: target.horizon ?? undefined,
        squadId: target.squadId,
        startDate: dropDate,
        endDate: end,
      }]).catch(() => undefined);
      return;
    }
    if (!row || !backlogItem || !isBacklogCompatibleWithRow(backlogItem, row)) {
      if (backlogItem) controller.setAnnouncement(`${backlogItem.title} cannot be scheduled in that lane`);
      return;
    }
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const currentPointerClientX = dragPointerCurrentX.current;
    if (!canvasRect || currentPointerClientX === null) return;
    const pointerPosition = pointerClientToCanvasPosition(currentPointerClientX, canvasRect.left);
    const date = positionToInclusiveDate(pointerPosition, controller.viewportStart, controller.viewportEnd, timelineWidth);
    void controller.scheduleBacklog(backlogItem, row.horizon, date).catch(() => undefined);
  }

  function handleDragMove(event: DragMoveEvent) {
    const dragId = String(event.active.id);
    const railDrag = parseUnscheduledDragId(dragId);
    if (railDrag?.kind === "solution") {
      const item = controller.unscheduled.find((candidate) => candidate.kind === "solution" && candidate.id === railDrag.id);
      const row = rows.find((candidate) => candidate.id === event.over?.id);
      const dropDate = row && solutionDropTarget(row) ? dropDateUnderPointer() : null;
      if (!item || !row || !dropDate) {
        setGhost((current) => (current === null ? current : null));
        return;
      }
      const end = addCalendarDays(dropDate, durationDaysFor(null) - 1);
      setGhost((current) => (current && current.rowId === row.id && current.start === dropDate ? current : { rowId: row.id, start: dropDate, end, title: item.title }));
      return;
    }
    if (!dragId.startsWith("timeline:item:")) return;
    const item = controller.items.find((candidate) => `timeline:item:${candidate.id}` === dragId);
    const destination = rows.find((candidate) => candidate.id === event.over?.id);
    if (!item || destination?.kind !== "lane" || destination.squadId !== (item.squad?.id ?? null)) return;
    // Disable drag-to-regroup: mirrors handleDragEnd's fallback to the
    // item's own horizon when the destination row doesn't carry one.
    const destinationHorizon = destination.horizon ?? item.horizon;
    const days = timelinePixelDeltaToDays(event.delta.x, dayWidth);
    const range = { start: addCalendarDays(item.viewStart, days), end: addCalendarDays(item.viewEnd, days) };
    const overlapCount = controller.items.filter((candidate) => (
      candidate.id !== item.id
      && candidate.horizon === destinationHorizon
      && (candidate.squad?.id ?? null) === destination.squadId
      && candidate.viewStart <= range.end
      && candidate.viewEnd >= range.start
    )).length;
    controller.setAnnouncement(
      `${item.title} preview: ${destinationHorizon}, ${range.start} through ${range.end}, ${overlapCount === 0 ? "no overlaps" : `overlaps ${overlapCount} other ${overlapCount === 1 ? "item" : "items"}`}`,
    );
  }

  // ── Click-drag on an empty row: draw a range, then pick a solution to schedule into it ──
  function laneRowAt(target: EventTarget | null): TimelineRow | null {
    const element = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-lane-row]") : null;
    const row = element ? rows.find((candidate) => candidate.id === element.dataset.laneRow) : undefined;
    return row && solutionDropTarget(row) ? row : null;
  }
  function canvasX(clientX: number): number | null {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? pointerClientToCanvasPosition(clientX, rect.left) : null;
  }
  function beginRange(event: React.PointerEvent<HTMLDivElement>) {
    // Mouse and pen only: on touch the same gesture scrolls the timeline.
    if (event.button !== 0 || event.pointerType === "touch" || activeDragId) return;
    const row = laneRowAt(event.target);
    const x = canvasX(event.clientX);
    if (!row || x === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    rangeDraftRef.current = { rowId: row.id, startX: x, currentX: x };
    setRangeDraft(rangeDraftRef.current);
    setRangePopover(null);
  }
  function moveRange(event: React.PointerEvent<HTMLDivElement>) {
    const draft = rangeDraftRef.current;
    const x = canvasX(event.clientX);
    if (!draft || x === null) return;
    rangeDraftRef.current = { ...draft, currentX: x };
    setRangeDraft(rangeDraftRef.current);
  }
  function endRange(event: React.PointerEvent<HTMLDivElement>) {
    const draft = rangeDraftRef.current;
    rangeDraftRef.current = null;
    setRangeDraft(null);
    if (!draft || Math.abs(draft.currentX - draft.startX) < MIN_RANGE_DRAG_PX) return;
    const left = Math.min(draft.startX, draft.currentX);
    const right = Math.max(draft.startX, draft.currentX);
    setRangePopover({
      anchor: { x: event.clientX, y: event.clientY },
      rowId: draft.rowId,
      start: positionToInclusiveDate(left, controller.viewportStart, controller.viewportEnd, timelineWidth),
      end: positionToInclusiveDate(right, controller.viewportStart, controller.viewportEnd, timelineWidth),
    });
  }
  function cancelRange() {
    rangeDraftRef.current = null;
    setRangeDraft(null);
  }
  const popoverRow = rangePopover ? rows.find((row) => row.id === rangePopover.rowId) ?? null : null;
  const popoverTarget = popoverRow ? solutionDropTarget(popoverRow) : null;
  const popoverCandidates = useMemo<SolutionRailItem[]>(() => {
    if (!popoverTarget) return [];
    return controller.unscheduled
      .filter((item): item is SolutionRailItem => item.kind === "solution")
      .sort((a, b) => Number(b.squadId === popoverTarget.squadId) - Number(a.squadId === popoverTarget.squadId) || (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title));
  }, [controller.unscheduled, popoverTarget]);

  const showEmptyState = Boolean(props.roadmapEmpty) && controller.items.length === 0 && !manualMode;
  const draftRow = rangeDraft ? rows.find((row) => row.id === rangeDraft.rowId) : undefined;
  const ghostRow = ghost ? rows.find((row) => row.id === ghost.rowId) : undefined;

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col md:h-full md:min-h-0">
      <RoadmapHeader squads={props.headerSquads ?? props.squads} customFieldGroups={props.customFieldGroups} activeCustomFieldId={props.activeCustomFieldId ?? null} groupByValue={groupByValue} groupByOptions={props.groupByOptions} cardSortHref={props.cardSortHref} timeline={{ zoom: controller.zoom, onZoom: controller.setZoom, onShift: controller.shiftViewport, onToday: goToToday, saving: controller.pendingItemIds.size > 0 || controller.pendingBacklogIds.size > 0, schedule: { onOpen: () => setPaletteOpen(true), autoSync: true } }} />
      <div data-slot="workspace-content" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-4 md:px-4 md:py-3">
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragCancel={() => {
            stopDragPointerTracking();
            setActiveItemId(null);
            setActiveDragId(null);
            setGhost(null);
          }}
          onDragEnd={(event) => {
            setActiveItemId(null);
            setActiveDragId(null);
            setGhost(null);
            handleDragEnd(event);
            stopDragPointerTracking();
          }}
        >
          <section data-testid="timeline-engine-native" className="flex min-w-0 flex-col gap-3 p-1 min-[1320px]:flex-row min-[1320px]:items-start">
            <ScheduleRail
              className="max-h-80 min-[1320px]:sticky min-[1320px]:top-0 min-[1320px]:max-h-[calc(100dvh-9rem)] min-[1320px]:w-80 min-[1320px]:shrink-0"
              items={controller.unscheduled}
              squads={props.headerSquads ?? props.squads}
              autoAdded={autoAdded}
              pendingItemKeys={controller.pendingBacklogIds}
              onScheduleOne={(item) => { void controller.scheduleSolutions([{ solutionId: item.id }]).catch(() => undefined); }}
              onBulkSchedule={scheduleFromRail}
              onQuickAddFeedback={(item, horizon) => controller.quickAdd(item satisfies UnscheduledItem, horizon)}
              onUndoAuto={(item) => { void controller.undoCreated([item.id]).catch(() => undefined); }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
            {controller.reconciliationRequiredIds.size > 0 && <p role="alert" className="text-sm text-muted-foreground">An item changed elsewhere. Reload the timeline before editing it again.</p>}
            {showEmptyState ? (
              <BuildFromDiscovery
                catalog={catalog}
                scheduledIds={controller.scheduledSolutionIds}
                onBuild={(preset) => controller.buildFromDiscovery(preset)}
                onAddManually={() => {
                  setManualMode(true);
                  pushUndoToast({ message: "Blank roadmap. Drag from the left, draw on a row, or press / to search." });
                }}
              />
            ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="grid" style={{ gridTemplateColumns: `clamp(112px, 30vw, ${LABEL_WIDTH}px) minmax(0, 1fr)` }}>
                <div className="border-r bg-card">
                  <div className="flex items-end border-b bg-muted/30 px-3 pb-2 text-xs font-semibold text-muted-foreground" style={{ height: HEADER_HEIGHT }}>
                    {grouping.axisLabel}
                  </div>
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      className={row.kind === "horizon" ? "flex items-center gap-2 border-b bg-muted px-3 text-xs font-bold uppercase tracking-wide text-text-subtle" : "flex items-center gap-2 border-b px-5 text-sm text-text-subtle"}
                      style={{ height: rowHeights.get(row.id) ?? LANE_HEIGHT }}
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ background: row.color ?? "#cbd5e1" }} />
                      <span className="truncate">{row.label}</span>
                    </div>
                  ))}
                </div>
                <div
                  ref={scrollRef}
                  className="overflow-x-auto"
                  data-testid="native-timeline-scroll"
                  data-scroll-left-px={Math.round(scrollViewport.scrollLeft)}
                  data-viewport-width-px={Math.round(scrollViewport.width)}
                  data-measurement-timing="pre-paint"
                  role="region"
                  aria-label="Timeline dates"
                  tabIndex={0}
                  onScroll={(event) => setScrollViewport({ scrollLeft: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth })}
                >
                  <div
                    ref={canvasRef}
                    className="relative"
                    data-logical-width-px={Math.round(timelineWidth)}
                    style={{ width: timelineWidth, minWidth: "100%" }}
                  >
                    <NativeHeaders start={controller.viewportStart} end={controller.viewportEnd} width={timelineWidth} />
                    <div
                      ref={gridRef}
                      className="relative overflow-hidden"
                      data-testid="timeline-grid"
                      onPointerDown={beginRange}
                      onPointerMove={moveRange}
                      onPointerUp={endRange}
                      onPointerCancel={cancelRange}
                      data-virtual-window-start-px={Math.round(renderWindow.start)}
                      data-virtual-window-end-px={Math.round(renderWindow.end)}
                      data-rendered-card-count={renderedItemLayouts.length}
                      data-total-card-count={itemLayouts.length}
                      style={{
                        height: bodyHeight,
                        backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${dayWidth - 1}px, color-mix(in oklab, var(--border) 60%, transparent) ${dayWidth}px)`,
                      }}
                    >
                      {rows.map((row) => (
                        <NativeLane
                          key={row.id}
                          row={row}
                          top={rowTops.get(row.id) ?? 0}
                          height={rowHeights.get(row.id) ?? LANE_HEIGHT}
                          disabled={!isRowValidForActiveDrag(row, activeDragId, controller.items, controller.unscheduled)}
                        />
                      ))}
                      <TodayLine start={controller.viewportStart} end={controller.viewportEnd} width={timelineWidth} />
                      {draftRow && rangeDraft ? (
                        <div
                          aria-hidden="true"
                          data-testid="timeline-range-draft"
                          className="pointer-events-none absolute z-10 h-9 rounded-lg border border-dashed border-primary bg-primary/15"
                          style={{ left: Math.min(rangeDraft.startX, rangeDraft.currentX), width: Math.abs(rangeDraft.currentX - rangeDraft.startX), top: (rowTops.get(draftRow.id) ?? 0) + 7 }}
                        />
                      ) : null}
                      {ghost && ghostRow ? (() => {
                        const left = dateToPosition(ghost.start, controller.viewportStart, controller.viewportEnd, timelineWidth);
                        const width = inclusiveDayCount(ghost.start, ghost.end) * dayWidth;
                        const top = (rowTops.get(ghostRow.id) ?? 0) + 7;
                        const tipLeft = left + width + 8 > timelineWidth - 240 ? Math.max(0, left - 236) : left + width + 8;
                        return (
                          <>
                            <div
                              aria-hidden="true"
                              data-testid="timeline-drop-ghost"
                              className="pointer-events-none absolute z-10 flex h-9 flex-col justify-center overflow-hidden rounded-lg border-2 border-dashed border-primary bg-primary/15 px-2 text-xs leading-tight text-foreground"
                              style={{ left, width, top }}
                            >
                              <span className="truncate font-semibold">{ghost.title}</span>
                              <span className="truncate text-[10px] text-muted-foreground">{formatShortDay(ghost.start)} – {formatShortDay(ghost.end)} · {Math.round(inclusiveDayCount(ghost.start, ghost.end) / 7)} wks</span>
                            </div>
                            <div
                              aria-hidden="true"
                              data-testid="timeline-drop-tip"
                              className="pointer-events-none absolute z-10 w-56 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium leading-tight text-background shadow-md"
                              style={{ left: tipLeft, top }}
                            >
                              Release to create roadmap item
                              <span className="block text-[10px] font-normal opacity-80">Linked to {labels.solution.lower} · squad {ghostRow.label} · inherits {labels.keyResult.lower}</span>
                            </div>
                          </>
                        );
                      })() : null}
                      {renderedItemLayouts.map(({ item, left, width, interactionWidth, top, track, trackCount, overlapCount }) => {
                        return (
                          <NativeItem
                            key={item.id}
                            item={item}
                            left={left}
                            width={width}
                            interactionWidth={interactionWidth}
                            top={top}
                            dayWidth={dayWidth}
                            track={track}
                            trackCount={trackCount}
                            overlapCount={overlapCount}
                            groupBadge={customFieldBadgeByItemId?.get(item.id) ?? null}
                            disabled={controller.pendingItemIds.has(item.id) || controller.reconciliationRequiredIds.has(item.id) || item.horizon === "LAUNCHING" || item.horizon === "LAUNCHED"}
                            onFocusChange={(focused) => setFocusedItemId(focused ? item.id : null)}
                            onOpen={() => openItem(item.id)}
                            onEdit={() => setEditing(item)}
                            onKeyboardMove={(days, horizon) => {
                              if (!isInternalTimelineDestination(item.horizon, horizon)) {
                                controller.setAnnouncement(`${item.title} cannot move to ${HORIZON_META[horizon].label} from the timeline`);
                                return;
                              }
                              const start = addCalendarDays(item.viewStart, days);
                              const end = addCalendarDays(item.viewEnd, days);
                              controller.setAnnouncement(`Moving ${item.title} to ${HORIZON_META[horizon].label}, ${start} through ${end}`);
                              void controller.reschedule(item.id, horizon, start, end).catch(() => undefined);
                            }}
                            onResize={(edge, delta) => {
                              const changed = addCalendarDays(edge === "left" ? item.viewStart : item.viewEnd, timelinePixelDeltaToDays(delta, dayWidth));
                              const resized = resizeRange(item.viewStart, item.viewEnd, edge, changed);
                              void controller.reschedule(item.id, item.horizon, resized.start, resized.end).catch(() => undefined);
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            )}
            <p className="sr-only" role="status" aria-live="polite">{controller.announcement}</p>
            <EditDatesDialog
              item={editing}
              open={Boolean(editing)}
              disabled={Boolean(editing && controller.reconciliationRequiredIds.has(editing.id))}
              start={editing?.viewStart ?? controller.viewportStart}
              end={editing?.viewEnd ?? controller.viewportStart}
              onOpenChange={(open) => { if (!open) setEditing(null); }}
              onSave={(horizon, start, end) => controller.reschedule(editing!.id, horizon, start, end)}
            />
            </div>
            <SchedulePalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              catalog={catalog}
              scheduledIds={controller.scheduledSolutionIds}
              suggestSlot={suggestSlotFor}
              onSchedule={scheduleFromPalette}
            />
            {rangePopover && popoverTarget ? (
              <RangeSchedulePopover
                anchor={rangePopover.anchor}
                range={{ start: rangePopover.start, end: rangePopover.end }}
                candidates={popoverCandidates}
                squadLabel={popoverRow?.label ?? ""}
                onClose={() => setRangePopover(null)}
                onPick={(item) => {
                  setRangePopover(null);
                  void controller.scheduleSolutions([{
                    solutionId: item.id,
                    horizon: popoverTarget.horizon ?? undefined,
                    squadId: popoverTarget.squadId,
                    startDate: rangePopover.start,
                    endDate: rangePopover.end,
                  }]).catch(() => undefined);
                }}
              />
            ) : null}
          </section>
        </DndContext>
      </div>
    </div>
  );
}

function clientXFromNativeEvent(event: Event): number | null {
  const pointerEvent = event as Event & { clientX?: unknown };
  if (typeof pointerEvent.clientX === "number") return pointerEvent.clientX;

  const touchEvent = event as Event & {
    touches?: ArrayLike<{ clientX: number }>;
    changedTouches?: ArrayLike<{ clientX: number }>;
  };
  return touchEvent.touches?.[0]?.clientX ?? touchEvent.changedTouches?.[0]?.clientX ?? null;
}

function NativeHeaders({ start, end, width }: { start: CalendarDate; end: CalendarDate; width: number }) {
  const months: Array<{ start: CalendarDate; end: CalendarDate; label: string; quarter: string }> = [];
  for (let cursor = start; cursor < end; cursor = addCalendarMonths(cursor, 1)) {
    const date = new Date(`${cursor}T00:00:00Z`);
    months.push({
      start: cursor,
      end: addCalendarMonths(cursor, 1),
      label: date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
      quarter: `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`,
    });
  }
  const quarters = Array.from(months.reduce((groups, month) => {
    const current = groups.get(month.quarter);
    if (current) current.end = month.end;
    else groups.set(month.quarter, { start: month.start, end: month.end, label: month.quarter });
    return groups;
  }, new Map<string, { start: CalendarDate; end: CalendarDate; label: string }>()).values());
  return (
    <div className="relative border-b bg-card" style={{ height: HEADER_HEIGHT }}>
      {quarters.map((quarter) => (
        <div key={`q-${quarter.start}`} className="absolute top-0 flex h-8 items-center border-r bg-muted/30 px-2 text-xs font-semibold text-text-subtle" style={{ left: dateToPosition(quarter.start, start, end, width), width: Math.max(1, dateToPosition(quarter.end, start, end, width) - dateToPosition(quarter.start, start, end, width)) }}>
          {quarter.label}
        </div>
      ))}
      {months.map((month) => (
        <div key={month.start} className="absolute bottom-0 flex h-10 items-center border-r px-2 text-xs text-muted-foreground" style={{ left: dateToPosition(month.start, start, end, width), width: dateToPosition(month.end, start, end, width) - dateToPosition(month.start, start, end, width) }}>
          {month.label}
        </div>
      ))}
    </div>
  );
}

function NativeLane({ row, top, height, disabled }: { row: TimelineRow; top: number; height: number; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: row.id, disabled, data: { row } });
  return <div ref={setNodeRef} data-testid={row.kind === "lane" ? `timeline-drop-${row.id}` : undefined} data-lane-row={row.kind === "lane" ? row.id : undefined} title={row.kind === "lane" ? "Click and drag to schedule" : undefined} className={`absolute inset-x-0 border-b ${row.kind === "horizon" ? "bg-muted/70" : isOver ? "bg-primary/5" : "bg-transparent"}`} style={{ top, height }} />;
}

function isRowValidForActiveDrag(
  row: TimelineRow,
  activeDragId: string | null,
  items: TimelineItemView[],
  unscheduled: TimelineEngineProps["unscheduledItems"],
): boolean {
  if (row.kind !== "lane") return false;
  if (!activeDragId) return true;
  if (activeDragId.startsWith("timeline:item:")) {
    const item = items.find((candidate) => `timeline:item:${candidate.id}` === activeDragId);
    // A row with no horizon (every non-Phase grouping mode) never changes
    // horizon on drop, so it is always a legal destination for its own squad.
    return Boolean(item && row.squadId === (item.squad?.id ?? null) && (row.horizon === null || isInternalTimelineDestination(item.horizon, row.horizon)));
  }
  const parsed = parseUnscheduledDragId(activeDragId);
  const item = parsed ? unscheduled.find((candidate) => candidate.kind === parsed.kind && candidate.id === parsed.id) : undefined;
  if (item?.kind === "solution") return solutionDropTarget(row) !== null;
  return Boolean(item && isBacklogCompatibleWithRow(item, row));
}

function NativeItem({ item, left, width, interactionWidth, top, dayWidth, track, trackCount, overlapCount, groupBadge, disabled, onOpen, onEdit, onResize, onKeyboardMove, onFocusChange }: { item: TimelineItemView; left: number; width: number; interactionWidth: number; top: number; dayWidth: number; track: number; trackCount: number; overlapCount: number; groupBadge?: { label: string; color: string | null } | null; disabled: boolean; onOpen: () => void; onEdit: () => void; onResize: (edge: "left" | "right", delta: number) => void; onKeyboardMove: (days: number, horizon: TimelineItemView["horizon"]) => void; onFocusChange: (focused: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `timeline:item:${item.id}`, disabled });
  const style = { left, top, width: interactionWidth, transform: CSS.Translate.toString(transform), zIndex: isDragging ? 30 : 5 };
  const displayOnly = item.horizon === "LAUNCHING" || item.horizon === "LAUNCHED";
  const useDialogFallback = !displayOnly && width < MIN_INLINE_WIDTH;
  return (
    <div
      ref={setNodeRef}
      className="absolute touch-pan-y"
      data-testid={`timeline-item-position-${item.id}`}
      data-timeline-item-id={item.id}
      data-track={track}
      data-track-count={trackCount}
      data-visual-width={width}
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(false);
      }}
      style={style}
    >
      {useDialogFallback ? (
        <>
          <div aria-hidden="true" className={`absolute top-0 h-9 rounded-lg ${item.hasDates ? "" : "border border-dashed"}`} style={{ width, backgroundColor: HORIZON_META[item.horizon].color }} />
          <button type="button" disabled={disabled} aria-label={`Edit schedule for ${item.title}`} className="relative z-10 inline-flex size-11 touch-manipulation items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onEdit}>
            <span className="sr-only">Edit horizon, start date, and end date</span>
          </button>
        </>
      ) : <TimelineCard item={item} start={item.viewStart} end={item.viewEnd} overlapCount={overlapCount} groupBadge={groupBadge} onOpen={onOpen} onEditDates={onEdit} editable={!displayOnly && !disabled} editControlClassName="mr-6" className={item.hasDates ? "" : "border-dashed"}>
        {!displayOnly ? <><button
          type="button" {...attributes} {...listeners} disabled={disabled} aria-label={`Move ${item.title}`}
          className="ml-6 inline-flex h-full w-6 shrink-0 touch-none cursor-grab items-center justify-center text-white/70 hover:bg-white/10 hover:text-white focus-visible:bg-white/20 focus-visible:text-white focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
          onKeyDown={(event) => {
            if (event.key.toLowerCase() === "d") { event.preventDefault(); onEdit(); return; }
            if (!event.altKey) return;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onKeyboardMove(event.key === "ArrowLeft" ? -1 : 1, item.horizon);
              return;
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const direction = event.key === "ArrowUp" ? -1 : 1;
              const origin = HORIZON_ORDER.indexOf(item.horizon);
              const candidate = HORIZON_ORDER
                .filter((_horizon, index) => direction < 0 ? index < origin : index > origin)
                .sort((left, right) => direction * (HORIZON_ORDER.indexOf(left) - HORIZON_ORDER.indexOf(right)))
                .find((horizon) => isInternalTimelineDestination(item.horizon, horizon));
              if (candidate) onKeyboardMove(0, candidate);
            }
          }}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
        <ResizeHandle edge="left" item={item} dayWidth={dayWidth} disabled={disabled} onResize={onResize} />
        <ResizeHandle edge="right" item={item} dayWidth={dayWidth} disabled={disabled} onResize={onResize} /></> : null}
      </TimelineCard>}
    </div>
  );
}

function canonicalOverlapCount(item: TimelineItemView, items: TimelineItemView[]): number {
  return 1 + items.filter((candidate) => candidate.id !== item.id
    && candidate.horizon === item.horizon
    && (candidate.squad?.id ?? null) === (item.squad?.id ?? null)
    && candidate.viewStart <= item.viewEnd
    && candidate.viewEnd >= item.viewStart).length;
}

function ResizeHandle({ edge, item, dayWidth, disabled, onResize }: { edge: "left" | "right"; item: TimelineItemView; dayWidth: number; disabled: boolean; onResize: (edge: "left" | "right", delta: number) => void }) {
  return (
    <button
      type="button"
      aria-label={`Resize ${edge} edge of ${item.title}`}
      disabled={disabled}
      className={`absolute inset-y-0 z-10 w-6 touch-none cursor-ew-resize focus-visible:bg-white/20 focus-visible:outline-none disabled:cursor-wait ${edge === "left" ? "left-0" : "right-0"}`}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResize(edge, event.key === "ArrowLeft" ? -dayWidth : dayWidth);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        const startX = event.clientX;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const cleanup = () => {
          target.removeEventListener("pointerup", finish);
          target.removeEventListener("pointercancel", cancel);
          target.removeEventListener("lostpointercapture", cancel);
        };
        const finish = (upEvent: PointerEvent) => {
          onResize(edge, upEvent.clientX - startX);
          cleanup();
        };
        const cancel = () => cleanup();
        target.addEventListener("pointerup", finish);
        target.addEventListener("pointercancel", cancel);
        target.addEventListener("lostpointercapture", cancel);
      }}
    >
      <span
        aria-hidden="true"
        data-resize-grip={edge}
        className={`pointer-events-none absolute inset-y-2 w-0.5 rounded-full bg-white/60 group-hover:bg-white group-focus-within:bg-white ${edge === "left" ? "left-0" : "right-0"}`}
      />
    </button>
  );
}

function TodayLine({ start, end, width }: { start: CalendarDate; end: CalendarDate; width: number }) {
  const value = localCalendarToday();
  if (value < start || value >= end) return null;
  return <div aria-label="Today marker" className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-status-danger" style={{ left: dateToPosition(value, start, end, width) }}><span className="absolute -top-5 -translate-x-1/2 rounded bg-status-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">Today</span></div>;
}
