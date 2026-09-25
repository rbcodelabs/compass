"use client";

import { useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { FlaskConical } from "lucide-react";
import { ExperimentCard, type ExperimentCardData } from "./experiment-card";
import {
  moveExperiment,
  reorderExperiment,
} from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions";
import type { ExperimentStatus } from "@/lib/types";
import { Board, BoardColumn, EmptyState } from "@/components/patterns";

const COLUMNS: { status: ExperimentStatus; label: string; accent: "neutral" | "info" | "success" | "danger" }[] = [
  { status: "DESIGNING", label: "Designing", accent: "neutral" },
  { status: "RUNNING", label: "Running", accent: "info" },
  { status: "COMPLETE", label: "Complete", accent: "success" },
  { status: "KILLED", label: "Killed", accent: "danger" },
];

const ALL_STATUSES: ExperimentStatus[] = ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"];

type ColumnMap = Record<ExperimentStatus, ExperimentCardData[]>;

function buildColumnMap(experiments: ExperimentCardData[]): ColumnMap {
  return ALL_STATUSES.reduce((acc, status) => {
    acc[status] = experiments
      .filter((e) => e.status === status)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return acc;
  }, {} as ColumnMap);
}

function findStatus(columns: ColumnMap, itemId: string): ExperimentStatus | null {
  for (const status of ALL_STATUSES) {
    if (columns[status].some((i) => i.id === itemId)) return status;
  }
  return null;
}

// ─── Column drop target ───────────────────────────────────────────────────────

function ExperimentColumn({
  status,
  label,
  accent,
  items,
  revalidatePathStr,
}: {
  status: ExperimentStatus;
  label: string;
  accent: "neutral" | "info" | "success" | "danger";
  items: ExperimentCardData[];
  revalidatePathStr: string;
}) {
  const itemIds = items.map((i) => i.id);
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <BoardColumn
      title={label}
      count={items.length}
      accent={accent}
      className="w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:overflow-hidden md:h-full"
      bodyRef={setNodeRef}
      bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
    >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <EmptyState compact icon={<FlaskConical className="size-4" />} title="No experiments yet" className={isOver ? "border-border-interactive" : undefined} />
          ) : (
            items.map((exp) => (
              <ExperimentCard
                key={exp.id}
                experiment={exp}
                revalidatePathStr={revalidatePathStr}
              />
            ))
          )}
        </SortableContext>
    </BoardColumn>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

type Props = {
  experiments: ExperimentCardData[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
};

export function ExperimentBoard({
  experiments,
  orgSlug,
  workspaceSlug,
  workspaceId,
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/experiments`;

  const [columns, setColumns] = useState<ColumnMap>(() =>
    buildColumnMap(experiments)
  );
  const [activeItem, setActiveItem] = useState<ExperimentCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<ExperimentStatus | null>(null);

  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    for (const status of ALL_STATUSES) {
      const found = columns[status].find((i) => i.id === id);
      if (found) {
        setActiveItem(found);
        setDragSourceStatus(status);
        return;
      }
    }
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const sourceStatus = findStatus(columns, activeId);
    if (!sourceStatus) return;

    let destStatus: ExperimentStatus;
    if (overId.startsWith("column-")) {
      destStatus = overId.replace("column-", "") as ExperimentStatus;
    } else {
      destStatus = findStatus(columns, overId) ?? sourceStatus;
    }

    if (sourceStatus === destStatus) return;

    setColumns((prev) => {
      const item = prev[sourceStatus].find((i) => i.id === activeId);
      if (!item) return prev;
      const updatedItem = { ...item, status: destStatus };

      let destItems = prev[destStatus].filter((i) => i.id !== activeId);
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
        [sourceStatus]: prev[sourceStatus].filter((i) => i.id !== activeId),
        [destStatus]: destItems,
      };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveItem(null);

    if (!over) {
      setDragSourceStatus(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const currentStatus = findStatus(columns, activeId);
    if (!currentStatus) {
      setDragSourceStatus(null);
      return;
    }

    if (dragSourceStatus && dragSourceStatus !== currentStatus) {
      startTransition(async () => {
        await moveExperiment(activeId, currentStatus, workspaceId, revalidatePathStr);
      });
    } else if (!overId.startsWith("column-") && overId !== activeId) {
      const columnItems = columns[currentStatus];
      const oldIndex = columnItems.findIndex((i) => i.id === activeId);
      const newIndex = columnItems.findIndex((i) => i.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(columnItems, oldIndex, newIndex).map((item, idx) => ({
          ...item,
          sortOrder: idx,
        }));
        setColumns((prev) => ({ ...prev, [currentStatus]: reordered }));

        startTransition(async () => {
          await reorderExperiment(activeId, newIndex, revalidatePathStr);
        });
      }
    }

    setDragSourceStatus(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <Board
          label="Experiment board"
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="experiment-board-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {COLUMNS.map(({ status, label, accent }) => (
              <ExperimentColumn
                key={status}
                status={status}
                label={label}
                accent={accent}
                items={columns[status]}
                revalidatePathStr={revalidatePathStr}
              />
            ))}
          </div>
        </Board>

        <DragOverlay>
          {activeItem ? (
            <div className="rotate-1 scale-105">
              <ExperimentCard
                experiment={activeItem}
                revalidatePathStr={revalidatePathStr}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
