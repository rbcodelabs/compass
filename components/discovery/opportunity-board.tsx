"use client";

import { useState, useTransition, useId } from "react";
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
import { Board, BoardColumn, EmptyState } from "@/components/patterns";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import { CreateOpportunityForm } from "./create-opportunity-form";
import {
  moveOpportunity,
  reorderOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { orderCards, planDragEnd } from "@/lib/discovery-board-ordering";
import type { OpportunityStatus, SquadData } from "@/lib/types";

const COLUMNS: { status: OpportunityStatus; label: string; accent: "neutral" | "info" | "warning" | "success" }[] = [
  { status: "EXPLORING", label: "Exploring", accent: "neutral" },
  { status: "VALIDATING", label: "Validating", accent: "warning" },
  { status: "PRIORITIZED", label: "Prioritized", accent: "info" },
  { status: "ACTIVE", label: "Active", accent: "success" },
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

/**
 * Score sort is a *view* on top of the canonical sortOrder state — `columns`
 * always holds manual order, and this derives the displayed order from it.
 * Keeping the two separate is what lets the board fall straight back to Rick's
 * manual order when the toggle goes off, with nothing re-persisted.
 */
function displayColumns(columns: ColumnMap, sortByScore: boolean): ColumnMap {
  if (!sortByScore) return columns;
  return ALL_STATUSES.reduce((acc, status) => {
    acc[status] = orderCards(columns[status], true);
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
  accent,
  items,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads,
  showScore,
  dragEnabled,
}: {
  status: OpportunityStatus;
  label: string;
  accent: "neutral" | "info" | "warning" | "success";
  items: OpportunityCardData[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  squads: SquadData[];
  showScore: boolean;
  dragEnabled: boolean;
}) {
  const itemIds = items.map((i) => i.id);
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  const cards =
    items.length === 0 ? (
      <EmptyState
        compact
        icon={<Lightbulb className="size-4" />}
        title="No opportunities yet"
        className={isOver ? "border-border-interactive" : undefined}
      />
    ) : (
      items.map((opp) => (
        <OpportunityCard
          key={opp.id}
          opportunity={opp}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          showScore={showScore}
          dragEnabled={dragEnabled}
        />
      ))
    );

  return (
    <BoardColumn
      title={label}
      count={items.length}
      accent={accent}
      className="w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:overflow-hidden md:h-full"
      bodyRef={setNodeRef}
      bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
      footer={<CreateOpportunityForm workspaceId={workspaceId} defaultStatus={status} squads={squads} />}
    >
        {dragEnabled ? (
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {cards}
          </SortableContext>
        ) : (
          cards
        )}
    </BoardColumn>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

type Props = {
  opportunitiesByStatus: Record<OpportunityStatus, OpportunityCardData[]>;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  squads?: SquadData[];
  /** True when the workspace has an active scoring model. */
  hasActiveScoringModel?: boolean;
  /** "Sort by score" view mode. Never persisted — see planDragEnd. */
  sortByScore?: boolean;
};

export function OpportunityBoard({
  opportunitiesByStatus,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads = [],
  hasActiveScoringModel = false,
  sortByScore = false,
}: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/discovery`;

  // Score sort is only meaningful when there is a model to score against.
  const scoreSortActive = hasActiveScoringModel && sortByScore;
  const dragEnabled = !scoreSortActive;

  const [columns, setColumns] = useState<ColumnMap>(() =>
    buildColumnMap(opportunitiesByStatus)
  );
  const [activeItem, setActiveItem] = useState<OpportunityCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<OpportunityStatus | null>(null);

  const [, startTransition] = useTransition();

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart(event: DragStartEvent) {
    if (!dragEnabled) return;
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
    if (!dragEnabled) return;
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

    const activeId = active.id as string;
    const overId = (over?.id as string | undefined) ?? null;
    const currentStatus = findStatus(columns, activeId);
    const columnItems = currentStatus ? columns[currentStatus] : [];

    const plan = planDragEnd({
      activeId,
      overId,
      currentStatus,
      dragSourceStatus,
      oldIndex: columnItems.findIndex((i) => i.id === activeId),
      newIndex: overId ? columnItems.findIndex((i) => i.id === overId) : -1,
      scoreSortActive,
    });

    if (plan.kind === "move") {
      startTransition(async () => {
        await moveOpportunity(activeId, plan.status, workspaceId, revalidatePathStr);
      });
    } else if (plan.kind === "reorder" && currentStatus) {
      const reordered = arrayMove(columnItems, plan.oldIndex, plan.newIndex).map(
        (item, idx) => ({ ...item, sortOrder: idx })
      );
      setColumns((prev) => ({ ...prev, [currentStatus]: reordered }));

      startTransition(async () => {
        await reorderOpportunity(activeId, plan.newIndex, revalidatePathStr);
      });
    }

    setDragSourceStatus(null);
  }

  const visibleColumns = displayColumns(columns, scoreSortActive);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <Board
          label="Opportunity board"
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="opportunity-board-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {COLUMNS.map(({ status, label, accent }) => (
              <DiscoveryColumn
                key={status}
                status={status}
                label={label}
                accent={accent}
                items={visibleColumns[status]}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                workspaceId={workspaceId}
                squads={squads}
                showScore={hasActiveScoringModel}
                dragEnabled={dragEnabled}
              />
            ))}
          </div>
        </Board>

        <DragOverlay>
          {activeItem ? (
            <div className="rotate-1 scale-105">
              <OpportunityCard
                opportunity={activeItem}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                showScore={hasActiveScoringModel}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
