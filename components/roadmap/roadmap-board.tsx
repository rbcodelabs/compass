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
import { moveItem, updateSortOrder } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { RoadmapColumn } from "./roadmap-column";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import type { Horizon } from "@/lib/types";

type ColumnMap = Record<Horizon, RoadmapCardData[]>;

const HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER"];

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
};

function buildColumnMap(items: RoadmapCardData[]): ColumnMap {
  return {
    NOW: items.filter((i) => i.horizon === "NOW").sort((a, b) => a.sortOrder - b.sortOrder),
    NEXT: items.filter((i) => i.horizon === "NEXT").sort((a, b) => a.sortOrder - b.sortOrder),
    LATER: items.filter((i) => i.horizon === "LATER").sort((a, b) => a.sortOrder - b.sortOrder),
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
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/roadmap`;

  const [columns, setColumns] = useState<ColumnMap>(() => buildColumnMap(initialItems));
  const [activeItem, setActiveItem] = useState<RoadmapCardData | null>(null);
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

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
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

    if (!over) {
      setDragSourceHorizon(null);
      return;
    }

    const activeId = active.id as string;
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
            availableKRs={availableKRs}
            availableSolutions={availableSolutions}
            availableOpportunities={availableOpportunities}
            availableExperiments={availableExperiments}
          />
        ))}
      </div>

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
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
