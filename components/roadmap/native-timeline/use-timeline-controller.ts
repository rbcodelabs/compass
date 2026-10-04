"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUrlState } from "@/hooks/use-url-state";
import {
  buildRoadmapFromDiscovery,
  promoteFeedbackToRoadmap,
  rescheduleRoadmapItem,
  scheduleSolutionsToRoadmap,
  undoRoadmapCreate,
  type RoadmapBuildPreset,
  type ScheduleSolutionRequest,
  type ScheduleSolutionsResult,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { pushUndoToast } from "@/lib/ui/undo-toast";
import { READY_STATUSES, type ScheduleCatalog } from "@/lib/roadmap/rail";
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

const solutionKey = (solutionId: string) => `unscheduled:solution:${solutionId}`;

export type CreateFromDiscoveryOptions = {
  /** Toast copy override; the default describes how many items were created. */
  message?: string;
  /** Suppress the Undo toast (the caller shows its own). */
  silent?: boolean;
};

export function useTimelineController({
  initialItems,
  initialUnscheduled,
  workspaceId,
  initialCatalog,
}: {
  initialItems: RoadmapCardData[];
  initialUnscheduled: UnscheduledItem[];
  workspaceId: string;
  /** Every live solution and whether it is already scheduled, for the palette and for restoring the rail after Undo. */
  initialCatalog?: ScheduleCatalog;
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
  const catalogRef = useRef(initialCatalog);
  const lastInitialCatalogRef = useRef(initialCatalog);
  const scheduledIdsRef = useRef(new Set(initialCatalog?.scheduledSolutionIds ?? []));
  const [scheduledSolutionIds, setScheduledSolutionIds] = useState<ReadonlySet<string>>(() => new Set(scheduledIdsRef.current));
  // Rail entries removed by a create, so Undo can put the exact card back.
  const removedRailRef = useRef(new Map<string, UnscheduledItem>());
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

  useEffect(() => {
    if (lastInitialCatalogRef.current === initialCatalog) return;
    lastInitialCatalogRef.current = initialCatalog;
    catalogRef.current = initialCatalog;
    // A refresh landing mid-create must not make a solution look unscheduled again.
    if (pendingBacklogIdsRef.current.size > 0 || !initialCatalog) return;
    const incoming = new Set(initialCatalog.scheduledSolutionIds);
    if (incoming.size === scheduledIdsRef.current.size && [...incoming].every((id) => scheduledIdsRef.current.has(id))) return;
    scheduledIdsRef.current = incoming;
    setScheduledSolutionIds(new Set(incoming));
  }, [initialCatalog]);

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

  /** Resets the viewport window around today and returns its start so the view can scroll today into sight. */
  function jumpToday(): CalendarDate {
    const nextStart = monthStart(addCalendarMonths(localCalendarToday(), zoom === "month" ? -2 : -6));
    setViewportStart(nextStart);
    return nextStart;
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
        // Solutions are created through the shared, idempotent Discovery path.
        await scheduleSolutionsToRoadmap(
          workspaceId,
          [{ solutionId: item.id, horizon: horizon as ScheduleSolutionRequest["horizon"], squadId: item.squadId, startDate: start, endDate: end }],
          localCalendarToday(),
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

  /** Rebuilds the rail card for a solution returned to the rail by an Undo. */
  function railItemFor(solutionId: string): UnscheduledItem | null {
    const removed = removedRailRef.current.get(solutionId);
    if (removed) return removed;
    const solution = catalogRef.current?.solutions.find((candidate) => candidate.id === solutionId);
    if (!solution || !READY_STATUSES.includes(solution.status)) return null;
    return {
      kind: "solution",
      id: solution.id,
      title: solution.title,
      opportunityId: solution.opportunityId,
      opportunityTitle: solution.opportunityTitle,
      squadId: solution.squadId,
      status: solution.status,
      score: solution.score,
    };
  }

  const squadFilterId = viewParams.get("squad");

  /**
   * Folds a server result into local state: the new bars appear, their solutions
   * leave the rail and count as scheduled. The follow-up refresh then confirms it.
   */
  function applyCreated(result: ScheduleSolutionsResult) {
    const createdSolutionIds = new Set<string>();
    const additions: RoadmapCardData[] = [];
    for (const card of result.created) {
      if (card.solutionId) createdSolutionIds.add(card.solutionId);
      confirmedItemsRef.current.set(card.id, card);
      // A squad filter hides other squads' bars; the item is still created, it just is not drawn here.
      if (!squadFilterId || card.squad?.id === squadFilterId) additions.push(card);
    }
    if (additions.length > 0) {
      const known = new Set(itemsRef.current.map((item) => item.id));
      const next = [...itemsRef.current, ...additions.filter((card) => !known.has(card.id))];
      itemsRef.current = next;
      setItems(next);
    }
    const leaving = new Set([...createdSolutionIds, ...result.existing.map((entry) => entry.solutionId)]);
    if (leaving.size > 0) {
      for (const entry of authoritativeUnscheduledRef.current) {
        if (entry.kind === "solution" && leaving.has(entry.id)) removedRailRef.current.set(entry.id, entry);
      }
      authoritativeUnscheduledRef.current = authoritativeUnscheduledRef.current.filter((entry) => !(entry.kind === "solution" && leaving.has(entry.id)));
      setUnscheduled((current) => current.filter((entry) => !(entry.kind === "solution" && leaving.has(entry.id))));
      for (const id of leaving) scheduledIdsRef.current.add(id);
      setScheduledSolutionIds(new Set(scheduledIdsRef.current));
    }
  }

  /**
   * Create linked roadmap items for solutions: from the rail, the palette, a
   * dropped card or a drawn range. Resolves with the created bars. Every create
   * gets an Undo toast unless `silent`.
   */
  async function scheduleSolutions(requests: ScheduleSolutionRequest[], options: CreateFromDiscoveryOptions = {}): Promise<RoadmapCardData[]> {
    const fresh = requests.filter((request) => !pendingBacklogIdsRef.current.has(solutionKey(request.solutionId)));
    if (fresh.length === 0) {
      setAnnouncement("Already being scheduled");
      return [];
    }
    for (const request of fresh) pendingBacklogIdsRef.current.add(solutionKey(request.solutionId));
    setPendingBacklogIds(new Set(pendingBacklogIdsRef.current));
    setAnnouncement(fresh.length === 1 ? "Creating roadmap item" : `Creating ${fresh.length} roadmap items`);
    try {
      const result = await scheduleSolutionsToRoadmap(workspaceId, fresh, localCalendarToday());
      applyCreated(result);
      announceCreated(result, options);
      router.refresh();
      return result.created;
    } catch (error) {
      setAnnouncement("Could not create the roadmap item. Try again.");
      throw error;
    } finally {
      for (const request of fresh) pendingBacklogIdsRef.current.delete(solutionKey(request.solutionId));
      setPendingBacklogIds(new Set(pendingBacklogIdsRef.current));
    }
  }

  /** The empty-roadmap flow: batch-create from a preset at proposed slots. */
  async function buildFromDiscovery(preset: RoadmapBuildPreset, options: CreateFromDiscoveryOptions = {}): Promise<RoadmapCardData[]> {
    setAnnouncement("Building the roadmap from discovery");
    try {
      const result = await buildRoadmapFromDiscovery(workspaceId, preset, localCalendarToday());
      applyCreated(result);
      announceCreated(result, { message: `Created ${result.created.length} roadmap ${result.created.length === 1 ? "item" : "items"} from discovery. Review and drag to adjust.`, ...options });
      router.refresh();
      return result.created;
    } catch (error) {
      setAnnouncement("Could not build the roadmap. Try again.");
      throw error;
    }
  }

  function announceCreated(result: ScheduleSolutionsResult, options: CreateFromDiscoveryOptions) {
    const count = result.created.length;
    if (count === 0) {
      setAnnouncement(result.existing.length > 0 ? "Already on the roadmap" : "Nothing to create");
      return;
    }
    const message = options.message ?? (count === 1 ? `Created roadmap item \u201c${result.created[0].title}\u201d` : `Created ${count} roadmap items`);
    setAnnouncement(message);
    if (options.silent) return;
    const ids = result.created.map((card) => card.id);
    pushUndoToast({ message, actionLabel: "Undo", onAction: () => undoCreated(ids) });
  }

  /**
   * Undo a create. The items are archived, never deleted, and their solutions
   * are not touched: each simply returns to the rail. An archived auto-created
   * item stays behind so Building auto-sync will not add it again.
   */
  async function undoCreated(itemIds: string[]) {
    const removing = new Set(itemIds);
    const gone = itemsRef.current.filter((item) => removing.has(item.id));
    try {
      await undoRoadmapCreate(workspaceId, itemIds);
    } catch (error) {
      setAnnouncement("Could not undo. Try again.");
      throw error;
    }
    const next = itemsRef.current.filter((item) => !removing.has(item.id));
    itemsRef.current = next;
    setItems(next);
    for (const id of itemIds) confirmedItemsRef.current.delete(id);
    const restored: UnscheduledItem[] = [];
    for (const item of gone) {
      if (!item.solutionId) continue;
      scheduledIdsRef.current.delete(item.solutionId);
      const entry = railItemFor(item.solutionId);
      if (entry) restored.push(entry);
    }
    setScheduledSolutionIds(new Set(scheduledIdsRef.current));
    if (restored.length > 0) {
      const present = new Set(authoritativeUnscheduledRef.current.map(backlogKey));
      const additions = restored.filter((entry) => !present.has(backlogKey(entry)));
      authoritativeUnscheduledRef.current = [...authoritativeUnscheduledRef.current, ...additions];
      setUnscheduled((current) => {
        const have = new Set(current.map(backlogKey));
        return [...current, ...additions.filter((entry) => !have.has(backlogKey(entry)))];
      });
    }
    setAnnouncement(itemIds.length === 1 ? "Removed from the roadmap" : `Removed ${itemIds.length} items from the roadmap`);
    router.refresh();
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
    scheduleSolutions,
    buildFromDiscovery,
    undoCreated,
    scheduledSolutionIds,
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
