"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUrlState } from "@/hooks/use-url-state";
import {
  promoteFeedbackToRoadmap,
  promoteToRoadmap,
  rescheduleRoadmapItem,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "../roadmap-card";
import { unscheduledDragId, type UnscheduledItem } from "../unscheduled-items-panel";
import type { Horizon } from "@/lib/types";
import { HORIZON_META } from "@/lib/roadmap";
import { usePanelContext } from "@/components/panels/panel-context";
import {
  addCalendarDays,
  addCalendarMonths,
  inclusiveDayCount,
  monthStart,
  utcDate,
  type CalendarDate,
  type TimelineZoom,
  NATIVE_BACKLOG_HORIZONS,
} from "./timeline-model";

export function localCalendarToday(now = new Date()): CalendarDate {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type TimelineItemView = RoadmapCardData & { viewStart: CalendarDate; viewEnd: CalendarDate; hasDates: boolean };

function projectTimelineItem(item: RoadmapCardData, placeholderStart: CalendarDate): TimelineItemView {
  const start = item.startDate?.slice(0, 10);
  const end = item.endDate?.slice(0, 10);
  if (start && end) {
    try {
      inclusiveDayCount(start, end);
      return { ...item, hasDates: true, viewStart: start, viewEnd: end };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  // Legacy/API records can contain incomplete or reversed dates. Project a
  // complete placeholder pair without rewriting their persisted schedule.
  return { ...item, hasDates: false, viewStart: placeholderStart, viewEnd: addCalendarDays(placeholderStart, 13) };
}

export function useTimelineController({
  initialItems,
  initialUnscheduled,
  workspaceId,
}: {
  initialItems: RoadmapCardData[];
  initialUnscheduled: UnscheduledItem[];
  workspaceId: string;
}) {
  const router = useRouter();
  const { subscribeEntityMutated } = usePanelContext();
  const [items, setItems] = useState(initialItems);
  const itemsRef = useRef(initialItems);
  const [unscheduled, setUnscheduled] = useState(initialUnscheduled);
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(() => new Set());
  const pendingItemIdsRef = useRef(new Set<string>());
  const pendingBacklogIdsRef = useRef(new Set<string>());
  const [pendingBacklogIds, setPendingBacklogIds] = useState<Set<string>>(() => new Set());
  const confirmedItemsRef = useRef(new Map(initialItems.map((item) => [item.id, item])));
  const localEchoFencesRef = useRef(new Map<string, { pre: RoadmapCardData; ack?: RoadmapCardData }>());
  const reconciliationRequiredIdsRef = useRef(new Set<string>());
  const [reconciliationRequiredIds, setReconciliationRequiredIds] = useState<Set<string>>(() => new Set());
  const authoritativeUnscheduledRef = useRef(initialUnscheduled);
  const lastInitialItemsRef = useRef(initialItems);
  const lastInitialUnscheduledRef = useRef(initialUnscheduled);
  // Keep presentation state across squad-key remounts without resetting save fences.
  const { params: viewParams, set: setViewParams } = useUrlState();
  const zoom: TimelineZoom = viewParams.get("timelineScale") === "quarter" ? "quarter" : "month";
  const setZoom = (value: TimelineZoom) => setViewParams({ timelineScale: value === "quarter" ? "quarter" : null });
  const [viewportStart, setViewportStart] = useState<CalendarDate>(() => monthStart(addCalendarMonths(localCalendarToday(), -2)));
  const [announcement, setAnnouncement] = useState("Timeline ready");
  const requireReconciliation = useCallback((id: string) => {
    reconciliationRequiredIdsRef.current.add(id);
    setReconciliationRequiredIds(new Set(reconciliationRequiredIdsRef.current));
    setAnnouncement(`Roadmap item changed concurrently. Reload this page before another edit.`);
    router.refresh();
  }, [router]);

  const viewportEnd = addCalendarMonths(viewportStart, zoom === "month" ? 6 : 18);
  const viewItems = useMemo<TimelineItemView[]>(
    () => {
      const placeholderStart = localCalendarToday();
      return items.map((item) => projectTimelineItem(item, placeholderStart));
    },
    [items],
  );

  useEffect(() => {
    if (lastInitialItemsRef.current === initialItems) return;
    lastInitialItemsRef.current = initialItems;
    setItems((current) => {
      const optimisticById = new Map(current.map((item) => [item.id, item]));
      const observedIds = new Set(initialItems.map((item) => item.id));
      const next = initialItems.map((incoming) => {
        const confirmed = confirmedItemsRef.current.get(incoming.id);
        const fence = localEchoFencesRef.current.get(incoming.id);
        if (fence) {
          if (sameSnapshot(incoming, fence.pre)) return optimisticById.get(incoming.id) ?? confirmed ?? incoming;
          if (fence.ack && sameSnapshot(incoming, fence.ack)) {
            localEchoFencesRef.current.delete(incoming.id);
            confirmedItemsRef.current.set(incoming.id, fence.ack);
            return pendingItemIdsRef.current.has(incoming.id) ? optimisticById.get(incoming.id) ?? fence.ack : fence.ack;
          }
          requireReconciliation(incoming.id);
          return optimisticById.get(incoming.id) ?? confirmed ?? incoming;
        }
        if (pendingItemIdsRef.current.has(incoming.id)) {
          requireReconciliation(incoming.id);
          return optimisticById.get(incoming.id) ?? confirmed ?? incoming;
        }
        if (confirmed && sameSnapshot(incoming, confirmed)) return confirmed;
        confirmedItemsRef.current.set(incoming.id, incoming);
        return pendingItemIdsRef.current.has(incoming.id) ? optimisticById.get(incoming.id) ?? incoming : incoming;
      });
      for (const item of current) if (!observedIds.has(item.id)) next.push(item);
      itemsRef.current = next;
      return roadmapItemsEqual(current, next) ? current : next;
    });
  }, [initialItems, requireReconciliation]);

  useEffect(() => {
    if (lastInitialUnscheduledRef.current === initialUnscheduled) return;
    lastInitialUnscheduledRef.current = initialUnscheduled;
    authoritativeUnscheduledRef.current = initialUnscheduled;
    setUnscheduled((current) => {
      const currentByKey = new Map(current.map((item) => [backlogKey(item), item]));
      const next = initialUnscheduled.map((item) => pendingBacklogIdsRef.current.has(unscheduledDragId(item))
        ? currentByKey.get(backlogKey(item)) ?? item
        : item);
      return unscheduledItemsEqual(current, next) ? current : next;
    });
  }, [initialUnscheduled]);

  useEffect(() => subscribeEntityMutated("roadmapItem", (id, patch) => {
    const confirmed = confirmedItemsRef.current.get(id);
    if (!confirmed || !patch?.updatedAt) {
      requireReconciliation(id);
      return;
    }
    const observed = { ...confirmed, ...(patch.horizon ? { horizon: patch.horizon } : {}), updatedAt: patch.updatedAt };
    const fence = localEchoFencesRef.current.get(id);
    if (fence || pendingItemIdsRef.current.has(id)) {
      if (fence && sameSnapshot(observed, fence.pre)) return;
      if (fence?.ack && sameSnapshot(observed, fence.ack)) {
        localEchoFencesRef.current.delete(id);
        return;
      }
      requireReconciliation(id);
      return;
    }
    confirmedItemsRef.current.set(id, observed);
    setItems((current) => {
      const next = current.map((item) => item.id === id ? observed : item);
      itemsRef.current = next;
      return next;
    });
  }), [requireReconciliation, subscribeEntityMutated]);

  function shiftViewport(direction: -1 | 1) {
    setViewportStart((current) => addCalendarMonths(current, direction * (zoom === "month" ? 3 : 9)));
  }

  function jumpToday() {
    setViewportStart(monthStart(addCalendarMonths(localCalendarToday(), zoom === "month" ? -2 : -6)));
  }

  async function reschedule(itemId: string, horizon: Horizon, start: CalendarDate, end: CalendarDate) {
    if (pendingItemIdsRef.current.has(itemId)) {
      throw new Error("This roadmap item is already being saved");
    }
    if (reconciliationRequiredIdsRef.current.has(itemId)) {
      throw new Error("This roadmap item must be reconciled before another edit");
    }
    const previousItem = itemsRef.current.find((item) => item.id === itemId);
    if (!previousItem) throw new Error("Roadmap item not found");
    pendingItemIdsRef.current.add(itemId);
    localEchoFencesRef.current.set(itemId, { pre: confirmedItemsRef.current.get(itemId) ?? previousItem });
    setPendingItemIds(new Set(pendingItemIdsRef.current));
    const nextItems = itemsRef.current.map((item) => item.id === itemId ? { ...item, horizon, startDate: start, endDate: end } : item);
    itemsRef.current = nextItems;
    setItems(nextItems);
    setAnnouncement(`Saving ${previousItem.title}`);
    try {
      const saved = await rescheduleRoadmapItem(itemId, workspaceId, {
        horizon,
        startDate: utcDate(start),
        endDate: utcDate(end),
      });
      const acknowledgedBase = confirmedItemsRef.current.get(itemId) ?? previousItem;
      const acknowledged = {
        ...acknowledgedBase,
        id: saved.id,
        horizon: saved.horizon as Horizon,
        startDate: normalizeServerDate(saved.startDate),
        endDate: normalizeServerDate(saved.endDate),
        updatedAt: normalizeServerRevision(saved.updatedAt),
      };
      confirmedItemsRef.current.set(itemId, acknowledged);
      localEchoFencesRef.current.set(itemId, { pre: localEchoFencesRef.current.get(itemId)?.pre ?? previousItem, ack: acknowledged });
      const settledItems = itemsRef.current.map((item) => item.id === itemId ? acknowledged : item);
      itemsRef.current = settledItems;
      setItems(settledItems);
      setAnnouncement(`${previousItem.title} saved to ${HORIZON_META[horizon].label}: ${start} through ${end}`);
      router.refresh();
    } catch (error) {
      const authoritative = confirmedItemsRef.current.get(itemId) ?? previousItem;
      localEchoFencesRef.current.delete(itemId);
      const rolledBack = itemsRef.current.map((item) => item.id === itemId ? authoritative : item);
      itemsRef.current = rolledBack;
      setItems(rolledBack);
      const recovery = reconciliationRequiredIdsRef.current.has(itemId)
        ? "Reload this page before another edit."
        : "Changes rolled back; try again.";
      setAnnouncement(`Could not save ${previousItem.title} to ${HORIZON_META[horizon].label}, ${start} through ${end}. ${recovery}`);
      throw error;
    } finally {
      pendingItemIdsRef.current.delete(itemId);
      setPendingItemIds(new Set(pendingItemIdsRef.current));
    }
  }

  async function scheduleBacklog(item: UnscheduledItem, horizon: Horizon, start: CalendarDate) {
    if (!NATIVE_BACKLOG_HORIZONS.includes(horizon)) {
      setAnnouncement(`${item.title} cannot be scheduled in ${horizon === "NOW" ? "Now" : horizon}`);
      return;
    }
    const pendingKey = backlogKey(item);
    if (pendingBacklogIdsRef.current.has(pendingKey)) {
      setAnnouncement(`${item.title} is already being scheduled`);
      return;
    }
    pendingBacklogIdsRef.current.add(pendingKey);
    setPendingBacklogIds(new Set(pendingBacklogIdsRef.current));
    const end = addCalendarDays(start, 13);
    setAnnouncement(`Scheduling ${item.title} from ${start} through ${end}`);
    try {
      if (item.kind === "solution") {
        await promoteToRoadmap(
          item.id,
          workspaceId,
          horizon,
          item.squadId,
          item.opportunityId,
          { startDate: utcDate(start), endDate: utcDate(end) },
        );
      } else {
        await promoteFeedbackToRoadmap(
          item.id,
          workspaceId,
          horizon,
          { startDate: utcDate(start), endDate: utcDate(end) },
        );
      }
      authoritativeUnscheduledRef.current = authoritativeUnscheduledRef.current.filter((candidate) => backlogKey(candidate) !== pendingKey);
      setUnscheduled((current) => current.filter((candidate) => backlogKey(candidate) !== pendingKey));
      setAnnouncement(`${item.title} scheduled for 14 days starting ${start}`);
      router.refresh();
    } catch (error) {
      const authoritativeItem = authoritativeUnscheduledRef.current.find((candidate) => backlogKey(candidate) === pendingKey);
      setUnscheduled((current) => {
        const currentIndex = current.findIndex((candidate) => backlogKey(candidate) === pendingKey);
        if (!authoritativeItem) return currentIndex === -1 ? current : current.filter((candidate) => backlogKey(candidate) !== pendingKey);
        if (currentIndex !== -1) return current.map((candidate, index) => index === currentIndex ? authoritativeItem : candidate);
        return [...current, authoritativeItem];
      });
      setAnnouncement(`Could not schedule ${item.title}. Try again.`);
      throw error;
    } finally {
      pendingBacklogIdsRef.current.delete(pendingKey);
      setPendingBacklogIds(new Set(pendingBacklogIdsRef.current));
    }
  }

  function quickAdd(item: UnscheduledItem, horizon: Horizon) {
    void scheduleBacklog(item, horizon, localCalendarToday()).catch(() => undefined);
  }

  return {
    items: viewItems,
    unscheduled,
    zoom,
    setZoom,
    viewportStart,
    viewportEnd,
    shiftViewport,
    jumpToday,
    reschedule,
    pendingItemIds,
    pendingBacklogIds,
    reconciliationRequiredIds,
    scheduleBacklog,
    quickAdd,
    announcement,
    setAnnouncement,
  };
}

function sameSnapshot(left: RoadmapCardData, right: RoadmapCardData): boolean {
  return left.updatedAt === right.updatedAt && left.horizon === right.horizon && left.startDate === right.startDate && left.endDate === right.endDate;
}

function normalizeServerDate(value: Date | string | null): string | null {
  return value ? (typeof value === "string" ? value : value.toISOString()) : null;
}

function normalizeServerRevision(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function roadmapItemsEqual(left: RoadmapCardData[], right: RoadmapCardData[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined && JSON.stringify(item) === JSON.stringify(candidate);
  });
}

function unscheduledItemsEqual(left: UnscheduledItem[], right: UnscheduledItem[]): boolean {
  return left.length === right.length && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}

function backlogKey(item: UnscheduledItem): string {
  return unscheduledDragId(item);
}
