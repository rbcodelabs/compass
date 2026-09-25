"use client";

import { useState, useTransition, useCallback, useEffect, useId } from "react";
import {
  DndContext,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import {
  moveItem,
  updateSortOrder,
  promoteToRoadmap,
  promoteFeedbackToRoadmap,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { RoadmapColumn } from "./roadmap-column";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import {
  UnscheduledItemsColumn,
  UnscheduledItemPreview,
  parseUnscheduledDragId,
  type UnscheduledItem,
} from "./unscheduled-items-panel";
import { usePanelContext } from "@/components/panels/panel-context";
import { INTERNAL_BOARD_HORIZONS, getInternalBoardHorizons, isLaunchHorizon } from "@/lib/roadmap";
import type { Horizon, SquadData } from "@/lib/types";
import { Board } from "@/components/patterns/board";

type ColumnMap = Record<Horizon, RoadmapCardData[]>;

const HORIZONS: Horizon[] = INTERNAL_BOARD_HORIZONS;

type AvailableKR = { id: string; title: string; objectiveTitle: string };
type AvailableSolution = { id: string; title: string; opportunityTitle: string };
type AvailableOpportunity = { id: string; title: string };
type AvailableExperiment = { id: string; title: string; status: string };

type Props = {
  initialItems: RoadmapCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  availableKRs?: AvailableKR[];
  availableSolutions?: AvailableSolution[];
  availableOpportunities?: AvailableOpportunity[];
  availableExperiments?: AvailableExperiment[];
  unscheduledItems?: UnscheduledItem[];
  squads?: SquadData[];
  // Purely visual/advisory WIP limits — only NOW and NEXT ever receive one.
  // See docs/decisions/0005/0006 (Superseded); never wire into blocking
  // behavior.
  nowLimit?: number | null;
  nextLimit?: number | null;
  // Gates the LAUNCHING/LAUNCHED columns and the launch chip/menu item on
  // cards. Any item still sitting in a launch horizon while this is off
  // displays folded into SHIPPED (see internalBucketFor in lib/roadmap.ts)
  // rather than disappearing.
  launchWorkflowEnabled: boolean;
};

// Builds a RoadmapCardData for a newly-created item from a promote action's
// return value (a raw RoadmapItem row) plus the UnscheduledItem it came
// from — the promote actions don't re-fetch/join solution/opportunity data,
// so the card's relation fields are filled in from what we already know
// client-side rather than round-tripping for it.
function cardDataFromPromotion(
  created: {
    id: string;
    title: string;
    description: string | null;
    horizon: string;
    sortOrder: number;
    solutionId: string | null;
    keyResultId: string | null;
    opportunityId: string | null;
    experimentId: string | null;
    feedbackId: string | null;
    startDate: Date | null;
    endDate: Date | null;
    isPrivate: boolean;
    updatedAt: Date;
  },
  source: UnscheduledItem,
  squads: SquadData[]
): RoadmapCardData {
  // Only solution-sourced items carry a squadId (inherited from the
  // opportunity's squad, resolved server-side in page.tsx's unscheduledItems
  // query) — feedback/bug items have no squad concept. Resolve the id against
  // the already-fetched squads list rather than round-tripping for it, same
  // as every other relation field on this optimistic card.
  const squad =
    source.kind === "solution" && source.squadId
      ? (squads.find((s) => s.id === source.squadId) ?? null)
      : null;

  return {
    id: created.id,
    title: created.title,
    description: created.description ?? null,
    horizon: created.horizon as Horizon,
    sortOrder: created.sortOrder,
    isPrivate: created.isPrivate,
    solutionId: created.solutionId ?? null,
    keyResultId: created.keyResultId ?? null,
    opportunityId: created.opportunityId ?? null,
    experimentId: created.experimentId ?? null,
    feedbackId: created.feedbackId ?? null,
    startDate: created.startDate ? created.startDate.toISOString() : null,
    endDate: created.endDate ? created.endDate.toISOString() : null,
    updatedAt: created.updatedAt.toISOString(),
    solution: source.kind === "solution" ? { id: source.id, title: source.title } : null,
    keyResult: null,
    opportunity:
      source.kind === "solution" ? { id: source.opportunityId, title: source.opportunityTitle } : null,
    experiment: null,
    feedback: source.kind === "feedback" ? { id: source.id, title: source.title, type: "BUG" } : null,
    squad,
    launchChecklist: null,
    deliveryStatus: "NOT_STARTED",
  };
}

export function buildColumnMap(items: RoadmapCardData[]): ColumnMap {
  // Exhaustive over every horizon so columns[horizon] is never undefined at
  // runtime, even for horizons that currently hold no items.
  const map = Object.fromEntries(HORIZONS.map((h) => [h, [] as RoadmapCardData[]])) as ColumnMap;
  for (const item of items) {
    (map[item.horizon] ??= []).push(item);
  }
  for (const h of HORIZONS) {
    map[h].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return map;
}

// Find which column (horizon) an item currently lives in.
function findHorizon(columns: ColumnMap, itemId: string): Horizon | null {
  for (const horizon of HORIZONS) {
    if (columns[horizon].some((i) => i.id === itemId)) return horizon;
  }
  return null;
}

/**
 * Move a card into `targetHorizon`, wherever it currently lives in `columns`.
 * Used to apply an out-of-band "this item is now horizon X" update (e.g. a
 * launch tier picked in the roadmap-item panel, which the board otherwise has
 * no way to learn about — see the subscribeEntityMutated effect below) to the
 * board's client-only optimistic state, without a full data refetch.
 *
 * No-op (returns the same `columns` reference) if the card is already in
 * `targetHorizon` or isn't found in any column, so callers can pass this
 * straight to a setState updater without an extra guard.
 */
export function moveCardToHorizon(
  columns: ColumnMap,
  itemId: string,
  targetHorizon: Horizon
): ColumnMap {
  const sourceHorizon = findHorizon(columns, itemId);
  if (!sourceHorizon || sourceHorizon === targetHorizon) return columns;

  const item = columns[sourceHorizon].find((i) => i.id === itemId);
  if (!item) return columns;
  const moved = { ...item, horizon: targetHorizon };

  return {
    ...columns,
    [sourceHorizon]: columns[sourceHorizon].filter((i) => i.id !== itemId),
    [targetHorizon]: [...columns[targetHorizon], moved],
  };
}

export function RoadmapBoard({
  initialItems,
  workspaceId,
  orgSlug,
  workspaceSlug,
  availableKRs,
  availableSolutions,
  availableOpportunities,
  availableExperiments,
  unscheduledItems,
  squads,
  nowLimit,
  nextLimit,
  launchWorkflowEnabled,
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/roadmap`;
  const { openPanel, subscribeEntityMutated } = usePanelContext();

  const [columns, setColumns] = useState<ColumnMap>(() => buildColumnMap(initialItems));
  const visibleHorizons = getInternalBoardHorizons(launchWorkflowEnabled);
  // Display-only fold: an item's stored horizon is untouched, so it
  // un-folds automatically if the flag is re-enabled. Mirrors the public
  // portal's portalBucketFor treatment of LAUNCHED, extended to also fold
  // LAUNCHING when the whole launch workflow is off.
  const displayColumns: ColumnMap = launchWorkflowEnabled
    ? columns
    : {
        ...columns,
        SHIPPED: [...columns.SHIPPED, ...columns.LAUNCHING, ...columns.LAUNCHED].sort(
          (a, b) => a.sortOrder - b.sortOrder
        ),
      };
  const [unscheduled, setUnscheduled] = useState<UnscheduledItem[]>(unscheduledItems ?? []);
  const [activeItem, setActiveItem] = useState<RoadmapCardData | null>(null);
  const [activeUnscheduledItem, setActiveUnscheduledItem] = useState<UnscheduledItem | null>(null);
  // Track the horizon the drag started from so handleDragEnd can detect cross-column moves.
  const [dragSourceHorizon, setDragSourceHorizon] = useState<Horizon | null>(null);

  const [, startTransition] = useTransition();

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Dropping a card on Launching opens the roadmap-item panel (see
  // handleDragEnd below) instead of moving it directly — LAUNCHING requires a
  // tier + checklist, which only setLaunchTier can create. That panel is a
  // sibling of this board, not a child, so once the user actually picks a
  // tier there, this is how the board learns about it and finishes the move
  // it optimistically reverted on drop.
  useEffect(() => {
    return subscribeEntityMutated("roadmapItem", (id, patch) => {
      if (!patch?.horizon) return;
      setColumns((prev) => moveCardToHorizon(prev, id, patch.horizon!));
    });
  }, [subscribeEntityMutated]);

  // Shared by both the drag-and-drop path and the quick-add menu fallback.
  async function scheduleUnscheduledItem(item: UnscheduledItem, horizon: Horizon) {
    setUnscheduled((prev) => prev.filter((i) => i !== item));
    const created =
      item.kind === "solution"
        ? await promoteToRoadmap(item.id, workspaceId, horizon, item.squadId, item.opportunityId)
        : await promoteFeedbackToRoadmap(item.id, workspaceId, horizon);
    handleItemAdded(cardDataFromPromotion(created, item, squads ?? []));
  }

  function handleQuickAdd(item: UnscheduledItem, horizon: Horizon) {
    startTransition(() => {
      scheduleUnscheduledItem(item, horizon);
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;

    const parsed = parseUnscheduledDragId(id);
    if (parsed) {
      const found = unscheduled.find((i) => i.id === parsed.id && i.kind === parsed.kind);
      if (found) setActiveUnscheduledItem(found);
      return;
    }

    for (const horizon of HORIZONS) {
      const found = columns[horizon].find((i) => i.id === id);
      if (found) {
        setActiveItem(found);
        setDragSourceHorizon(horizon);
        return;
      }
    }
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const sourceHorizon = findHorizon(columns, activeId);
    if (!sourceHorizon) return;

    let destHorizon: Horizon;
    if (overId.startsWith("column-")) {
      destHorizon = overId.replace("column-", "") as Horizon;
    } else {
      destHorizon = findHorizon(columns, overId) ?? sourceHorizon;
    }

    if (sourceHorizon === destHorizon) return;

    setColumns((prev) => {
      const item = prev[sourceHorizon].find((i) => i.id === activeId);
      if (!item) return prev;
      const updatedItem = { ...item, horizon: destHorizon };

      let destItems = prev[destHorizon].filter((i) => i.id !== activeId);
      if (!overId.startsWith("column-")) {
        const overIndex = destItems.findIndex((i) => i.id === overId);
        if (overIndex >= 0) {
          destItems = [
            ...destItems.slice(0, overIndex),
            updatedItem,
            ...destItems.slice(overIndex),
          ];
        } else {
          destItems = [...destItems, updatedItem];
        }
      } else {
        destItems = [...destItems, updatedItem];
      }

      return {
        ...prev,
        [sourceHorizon]: prev[sourceHorizon].filter((i) => i.id !== activeId),
        [destHorizon]: destItems,
      };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveItem(null);

    const activeId = active.id as string;
    const parsed = parseUnscheduledDragId(activeId);
    if (parsed) {
      setActiveUnscheduledItem(null);
      if (!over) return;

      const overId = over.id as string;
      const destHorizon = overId.startsWith("column-")
        ? (overId.replace("column-", "") as Horizon)
        : findHorizon(columns, overId);
      if (!destHorizon) return; // dropped somewhere that isn't a horizon column/card

      const item = unscheduled.find((i) => i.id === parsed.id && i.kind === parsed.kind);
      if (!item) return;

      startTransition(() => {
        scheduleUnscheduledItem(item, destHorizon);
      });
      return;
    }

    if (!over) {
      setDragSourceHorizon(null);
      return;
    }

    const overId = over.id as string;

    const currentHorizon = findHorizon(columns, activeId);
    if (!currentHorizon) {
      setDragSourceHorizon(null);
      return;
    }

    if (dragSourceHorizon && dragSourceHorizon !== currentHorizon) {
      // Dropping onto a launch column can't be a plain move — LAUNCHING needs
      // a tier + checklist. Revert the optimistic move from handleDragOver and
      // open the item's panel so the user can pick a launch tier there.
      if (isLaunchHorizon(currentHorizon)) {
        const source = dragSourceHorizon;
        setColumns((prev) => {
          const moved = prev[currentHorizon].find((i) => i.id === activeId);
          if (!moved) return prev;
          const reverted = { ...moved, horizon: source };
          return {
            ...prev,
            [currentHorizon]: prev[currentHorizon].filter((i) => i.id !== activeId),
            [source]: [...prev[source].filter((i) => i.id !== activeId), reverted],
          };
        });
        setDragSourceHorizon(null);
        openPanel("roadmapItem", activeId);
        return;
      }
      startTransition(async () => {
        await moveItem(activeId, currentHorizon, workspaceId);
      });
    } else if (!overId.startsWith("column-") && overId !== activeId) {
      const columnItems = columns[currentHorizon];
      const oldIndex = columnItems.findIndex((i) => i.id === activeId);
      const newIndex = columnItems.findIndex((i) => i.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(columnItems, oldIndex, newIndex).map((item, idx) => ({
          ...item,
          sortOrder: idx,
        }));
        setColumns((prev) => ({ ...prev, [currentHorizon]: reordered }));

        startTransition(async () => {
          await updateSortOrder(activeId, workspaceId, newIndex);
        });
      }
    }

    setDragSourceHorizon(null);
  }

  const handleArchive = useCallback((itemId: string) => {
    setColumns((prev) => {
      const next = { ...prev };
      for (const horizon of HORIZONS) {
        next[horizon] = prev[horizon].filter((i) => i.id !== itemId);
      }
      return next;
    });
  }, []);

  function handleItemAdded(item: RoadmapCardData) {
    setColumns((prev) => ({
      ...prev,
      [item.horizon]: [...prev[item.horizon], item],
    }));
  }

  const handleUpdate = useCallback((updated: RoadmapCardData) => {
    setColumns((prev) => ({
      ...prev,
      [updated.horizon]: prev[updated.horizon].map((i) =>
        i.id === updated.id ? updated : i
      ),
    }));
  }, []);

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto md:overflow-hidden">
        <Board
          label="Roadmap board"
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="roadmap-board-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {visibleHorizons.map((horizon) => (
              <RoadmapColumn
                key={horizon}
                horizon={horizon}
                items={displayColumns[horizon]}
                workspaceId={workspaceId}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                revalidatePathStr={revalidatePathStr}
                onItemAdded={handleItemAdded}
                onArchive={handleArchive}
                onUpdate={handleUpdate}
                availableKRs={availableKRs}
                availableSolutions={availableSolutions}
                availableOpportunities={availableOpportunities}
                availableExperiments={availableExperiments}
                limit={horizon === "NOW" ? nowLimit : horizon === "NEXT" ? nextLimit : undefined}
                launchWorkflowEnabled={launchWorkflowEnabled}
              />
            ))}
            <UnscheduledItemsColumn items={unscheduled} onQuickAdd={handleQuickAdd} />
          </div>
        </Board>
      </div>

      {/* DragOverlay renders the card being dragged at its cursor position */}
      <DragOverlay>
        {activeItem ? (
          <div className="rotate-1 scale-105">
            <RoadmapCard
              item={activeItem}
              workspaceId={workspaceId}
              revalidatePathStr={revalidatePathStr}
              onArchive={() => {}}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              availableOpportunities={availableOpportunities}
              launchWorkflowEnabled={launchWorkflowEnabled}
            />
          </div>
        ) : activeUnscheduledItem ? (
          <UnscheduledItemPreview item={activeUnscheduledItem} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
