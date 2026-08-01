"use client";

import { useState, useTransition, useCallback } from "react";
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
  UnscheduledItemsPanel,
  UnscheduledItemPreview,
  parseUnscheduledDragId,
  type UnscheduledItem,
} from "./unscheduled-items-panel";
import type { Horizon, SquadData } from "@/lib/types";

type ColumnMap = Record<Horizon, RoadmapCardData[]>;

const HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER", "SHIPPED"];

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
    solution: source.kind === "solution" ? { id: source.id, title: source.title } : null,
    keyResult: null,
    opportunity:
      source.kind === "solution" ? { id: source.opportunityId, title: source.opportunityTitle } : null,
    experiment: null,
    feedback: source.kind === "feedback" ? { id: source.id, title: source.title, type: "BUG" } : null,
    squad,
  };
}

function buildColumnMap(items: RoadmapCardData[]): ColumnMap {
  return {
    NOW: items.filter((i) => i.horizon === "NOW").sort((a, b) => a.sortOrder - b.sortOrder),
    NEXT: items.filter((i) => i.horizon === "NEXT").sort((a, b) => a.sortOrder - b.sortOrder),
    LATER: items.filter((i) => i.horizon === "LATER").sort((a, b) => a.sortOrder - b.sortOrder),
    SHIPPED: items.filter((i) => i.horizon === "SHIPPED").sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

// Find which column (horizon) an item currently lives in.
function findHorizon(columns: ColumnMap, itemId: string): Horizon | null {
  for (const horizon of HORIZONS) {
    if (columns[horizon].some((i) => i.id === itemId)) return horizon;
  }
  return null;
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
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/roadmap`;

  const [columns, setColumns] = useState<ColumnMap>(() => buildColumnMap(initialItems));
  const [unscheduled, setUnscheduled] = useState<UnscheduledItem[]>(unscheduledItems ?? []);
  const [activeItem, setActiveItem] = useState<RoadmapCardData | null>(null);
  const [activeUnscheduledItem, setActiveUnscheduledItem] = useState<UnscheduledItem | null>(null);
  // Track the horizon the drag started from so handleDragEnd can detect cross-column moves.
  const [dragSourceHorizon, setDragSourceHorizon] = useState<Horizon | null>(null);

  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Shared by both the drag-and-drop path and the quick-add menu fallback.
  async function scheduleUnscheduledItem(item: UnscheduledItem, horizon: Horizon) {
    setUnscheduled((prev) => prev.filter((i) => i !== item));
    const created =
      item.kind === "solution"
        ? await promoteToRoadmap(item.id, workspaceId, horizon, item.squadId, item.opportunityId)
        : await promoteFeedbackToRoadmap(item.id, workspaceId, horizon, revalidatePathStr);
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
      startTransition(async () => {
        await moveItem(activeId, currentHorizon, workspaceId, revalidatePathStr);
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
          await updateSortOrder(activeId, newIndex, revalidatePathStr);
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
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-6 items-start">
        {HORIZONS.map((horizon) => (
          <RoadmapColumn
            key={horizon}
            horizon={horizon}
            items={columns[horizon]}
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
          />
        ))}
      </div>

      <UnscheduledItemsPanel items={unscheduled} onQuickAdd={handleQuickAdd} />

      {/* DragOverlay renders the card being dragged at its cursor position */}
      <DragOverlay>
        {activeItem ? (
          <div className="rotate-1 scale-105">
            <RoadmapCard
              item={activeItem}
              revalidatePathStr={revalidatePathStr}
              onArchive={() => {}}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          </div>
        ) : activeUnscheduledItem ? (
          <UnscheduledItemPreview item={activeUnscheduledItem} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
