"use client";

import { useState, useTransition, useCallback } from "react";
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
import { Lightbulb } from "lucide-react";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import { CreateOpportunityForm } from "./create-opportunity-form";
import {
  moveOpportunity,
  reorderOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus, SquadData } from "@/lib/types";

const COLUMNS: { status: OpportunityStatus; label: string; color: string }[] = [
  { status: "EXPLORING", label: "Exploring", color: "bg-violet-500" },
  { status: "VALIDATING", label: "Validating", color: "bg-amber-500" },
  { status: "PRIORITIZED", label: "Prioritized", color: "bg-blue-500" },
  { status: "ACTIVE", label: "Active", color: "bg-emerald-500" },
];

const ALL_STATUSES: OpportunityStatus[] = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"];

type ColumnMap = Record<OpportunityStatus, OpportunityCardData[]>;

function buildColumnMap(
  opportunitiesByStatus: Record<OpportunityStatus, OpportunityCardData[]>
): ColumnMap {
  return ALL_STATUSES.reduce((acc, status) => {
    acc[status] = (opportunitiesByStatus[status] ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );
    return acc;
  }, {} as ColumnMap);
}

function findStatus(columns: ColumnMap, itemId: string): OpportunityStatus | null {
  for (const status of ALL_STATUSES) {
    if (columns[status].some((i) => i.id === itemId)) return status;
  }
  return null;
}

// ─── Column drop target ───────────────────────────────────────────────────────

function DiscoveryColumn({
  status,
  label,
  color,
  items,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads,
}: {
  status: OpportunityStatus;
  label: string;
  color: string;
  items: OpportunityCardData[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  squads: SquadData[];
}) {
  const itemIds = items.map((i) => i.id);
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <div className="flex flex-col gap-2 min-w-[280px] w-[280px]">
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
                <Lightbulb className="w-4 h-4 text-slate-400" />
              </div>
              <p className="text-xs text-slate-400">No opportunities yet</p>
            </div>
          ) : (
            items.map((opp) => (
              <OpportunityCard
                key={opp.id}
                opportunity={opp}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            ))
          )}
        </SortableContext>
      </div>

      {/* Add button */}
      <CreateOpportunityForm
        workspaceId={workspaceId}
        defaultStatus={status}
        squads={squads}
      />
    </div>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

type Props = {
  opportunitiesByStatus: Record<OpportunityStatus, OpportunityCardData[]>;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  squads?: SquadData[];
};

export function OpportunityBoard({
  opportunitiesByStatus,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads = [],
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/discovery`;

  const [columns, setColumns] = useState<ColumnMap>(() =>
    buildColumnMap(opportunitiesByStatus)
  );
  const [activeItem, setActiveItem] = useState<OpportunityCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<OpportunityStatus | null>(null);

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

    let destStatus: OpportunityStatus;
    if (overId.startsWith("column-")) {
      destStatus = overId.replace("column-", "") as OpportunityStatus;
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
      // Cross-column move — persist
      startTransition(async () => {
        await moveOpportunity(activeId, currentStatus, workspaceId, revalidatePathStr);
      });
    } else if (!overId.startsWith("column-") && overId !== activeId) {
      // Same-column reorder
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
          await reorderOpportunity(activeId, newIndex, revalidatePathStr);
        });
      }
    }

    setDragSourceStatus(null);
  }

  const handleArchive = useCallback((itemId: string) => {
    setColumns((prev) => {
      const next = { ...prev } as ColumnMap;
      for (const status of ALL_STATUSES) {
        next[status] = prev[status].filter((i) => i.id !== itemId);
      }
      return next;
    });
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map(({ status, label, color }) => (
          <DiscoveryColumn
            key={status}
            status={status}
            label={label}
            color={color}
            items={columns[status]}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            squads={squads}
          />
        ))}
      </div>

      <DragOverlay>
        {activeItem ? (
          <div className="rotate-1 scale-105">
            <OpportunityCard
              opportunity={activeItem}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
