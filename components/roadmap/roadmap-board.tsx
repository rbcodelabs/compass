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
import { AddItemDialog } from "./add-item-dialog";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import type { Horizon } from "@/lib/types";

type ColumnMap = Record<Horizon, RoadmapCardData[]>;

const HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER"];

type Props = {
  initialItems: RoadmapCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
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
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/roadmap`;

  const [columns, setColumns] = useState<ColumnMap>(() => buildColumnMap(initialItems));
  const [activeItem, setActiveItem] = useState<RoadmapCardData | null>(null);
  // Track the horizon the drag started from so handleDragEnd can detect cross-column moves.
  const [dragSourceHorizon, setDragSourceHorizon] = useState<Horizon | null>(null);

  const [, startTransition] = useTransition();

  // Controlled add-item dialog state: which horizon, and whether open.
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogHorizon, setAddDialogHorizon] = useState<Horizon>("NOW");

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require 8px movement before drag starts — prevents accidental drags on clicks.
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

    // Resolve destination horizon.
    let destHorizon: Horizon;
    if (overId.startsWith("column-")) {
      destHorizon = overId.replace("column-", "") as Horizon;
    } else {
      destHorizon = findHorizon(columns, overId) ?? sourceHorizon;
    }

    if (sourceHorizon === destHorizon) return;

    // Optimistically move the item into the destination column while dragging.
    setColumns((prev) => {
      const item = prev[sourceHorizon].find((i) => i.id === activeId);
      if (!item) return prev;
      const updatedItem = { ...item, horizon: destHorizon };

      // Insert before the hovered card, or at the end if hovering the column.
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

    // After dragOver has already moved the item optimistically, find its current horizon.
    const currentHorizon = findHorizon(columns, activeId);
    if (!currentHorizon) {
      setDragSourceHorizon(null);
      return;
    }

    if (dragSourceHorizon && dragSourceHorizon !== currentHorizon) {
      // Cross-column move — persist to server.
      startTransition(async () => {
        await moveItem(activeId, currentHorizon, workspaceId, revalidatePathStr);
      });
    } else if (!overId.startsWith("column-") && overId !== activeId) {
      // Same-column reorder — finalise the order and persist.
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

  function handleColumnAdd(horizon: Horizon) {
    setAddDialogHorizon(horizon);
    setAddDialogOpen(true);
  }

  function handleItemAdded(item: RoadmapCardData) {
    setColumns((prev) => ({
      ...prev,
      [item.horizon]: [...prev[item.horizon], item],
    }));
  }

  return (
    <>
      {/* Board-level "Add Item" button — default horizon NOW. */}
      <div className="flex justify-end shrink-0">
        <Button onClick={() => { setAddDialogHorizon("NOW"); setAddDialogOpen(true); }}>
          <PlusIcon />
          Add Item
        </Button>
      </div>

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
              revalidatePathStr={revalidatePathStr}
              onAdd={handleColumnAdd}
              onArchive={handleArchive}
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
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Controlled dialog: opened when the user clicks "+" in a column header. */}
      <AddItemDialog
        workspaceId={workspaceId}
        defaultHorizon={addDialogHorizon}
        revalidatePathStr={revalidatePathStr}
        onAdd={handleItemAdded}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />
    </>
  );
}
