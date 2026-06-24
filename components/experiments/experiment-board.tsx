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

const COLUMNS: { status: ExperimentStatus; label: string; color: string }[] = [
  { status: "DESIGNING", label: "Designing", color: "bg-slate-400" },
  { status: "RUNNING", label: "Running", color: "bg-blue-500" },
  { status: "COMPLETE", label: "Complete", color: "bg-emerald-500" },
  { status: "KILLED", label: "Killed", color: "bg-red-400" },
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
  color,
  items,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
}: {
  status: ExperimentStatus;
  label: string;
  color: string;
  items: ExperimentCardData[];
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
}) {
  const itemIds = items.map((i) => i.id);
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <div className="flex flex-col gap-2 min-w-[280px] flex-1">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 mb-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <span className="ml-auto text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
          {items.length}
        </span>
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={[
          "flex flex-col gap-2 rounded-xl p-2.5 min-h-[180px] transition-colors",
          isOver
            ? "bg-indigo-50/80 ring-2 ring-inset ring-indigo-200"
            : "bg-slate-100/80",
        ].join(" ")}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <div
              className={[
                "flex flex-col items-center justify-center gap-2 flex-1 min-h-[120px] rounded-lg border border-dashed py-6 transition-colors",
                isOver ? "border-indigo-300" : "border-slate-300/70",
              ].join(" ")}
            >
              <div className="w-8 h-8 rounded-full bg-slate-200/70 flex items-center justify-center">
                <FlaskConical className="w-4 h-4 text-slate-400" />
              </div>
              <p className="text-xs text-slate-400">No experiments yet</p>
            </div>
          ) : (
            items.map((exp) => (
              <ExperimentCard
                key={exp.id}
                experiment={exp}
                href={`/${orgSlug}/${workspaceSlug}/experiments/${exp.id}`}
                revalidatePathStr={revalidatePathStr}
              />
            ))
          )}
        </SortableContext>
      </div>
    </div>
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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        {COLUMNS.map(({ status, label, color }) => (
          <ExperimentColumn
            key={status}
            status={status}
            label={label}
            color={color}
            items={columns[status]}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            revalidatePathStr={revalidatePathStr}
          />
        ))}
      </div>

      <DragOverlay>
        {activeItem ? (
          <div className="rotate-1 scale-105">
            <ExperimentCard
              experiment={activeItem}
              href={`/${orgSlug}/${workspaceSlug}/experiments/${activeItem.id}`}
              revalidatePathStr={revalidatePathStr}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
