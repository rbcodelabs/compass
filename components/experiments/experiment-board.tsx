"use client";

import { useState, useTransition, useId } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { useFlipAnimation } from "@/hooks/use-flip-animation";
import {
  DndContext,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragCancelEvent,
  type DragOverEvent,
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
import {
  Board,
  BoardColumn,
  BoardDock,
  BOARD_FADE_END_TRACK_CLASS,
  EmptyState,
  PINNED_COLUMN_BODY_CLASS,
  PINNED_COLUMN_CLASS,
  type BoardColumnLayoutControls,
} from "@/components/patterns";
import { DroppableDockTab, dockAwareCollisionDetection } from "@/components/patterns/board-dock-dnd";
import { useBoardDock } from "@/components/patterns/use-board-dock";
import { useExperimentsColumnLayout } from "@/components/experiments/experiments-column-layout";
import { EXPERIMENT_BOARD_STATUSES } from "@/lib/experiments/board-layout";
import { dockTabDropStatus } from "@/lib/discovery-board-ordering";
import { cn } from "@/lib/utils";

const COLUMNS: { status: ExperimentStatus; label: string; accent: "neutral" | "info" | "success" | "danger" }[] = [
  { status: "DESIGNING", label: "Designing", accent: "neutral" },
  { status: "RUNNING", label: "Running", accent: "info" },
  { status: "COMPLETE", label: "Complete", accent: "success" },
  { status: "KILLED", label: "Killed", accent: "danger" },
];

const ALL_STATUSES = EXPERIMENT_BOARD_STATUSES as readonly ExperimentStatus[];
const COLUMN_BY_STATUS = Object.fromEntries(COLUMNS.map((c) => [c.status, c])) as Record<ExperimentStatus, (typeof COLUMNS)[number]>;

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
  placement = "scroller",
  layoutControls,
}: {
  status: ExperimentStatus;
  label: string;
  accent: "neutral" | "info" | "success" | "danger";
  items: ExperimentCardData[];
  revalidatePathStr: string;
  /** "pinned" is the dock's open panel: fixed width, no horizontal flex sizing. */
  placement?: "scroller" | "pinned";
  /** Pin / reorder / collapse controls in the column header (lib/board-layout.ts). */
  layoutControls?: BoardColumnLayoutControls;
}) {
  const pinned = placement === "pinned";
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
      data-experiment-column={status}
      className={pinned ? PINNED_COLUMN_CLASS : "w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:overflow-hidden md:h-full"}
      layoutControls={layoutControls}
      bodyRef={setNodeRef}
      bodyClassName={`${pinned ? PINNED_COLUMN_BODY_CLASS : "min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"} ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
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

  const [activeItem, setActiveItem] = useState<ExperimentCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<ExperimentStatus | null>(null);

  const [isPending, startTransition] = useTransition();

  // Follow the server unless a drag or local write is in flight (see useServerSyncedState).
  const busy = activeItem !== null || dragSourceStatus !== null || isPending;
  const { state: columns, setState: setColumns, generation } = useServerSyncedState(experiments, buildColumnMap, busy);
  const { containerRef, capture } = useFlipAnimation(generation);
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "experiments", paused: busy, onBeforeRefresh: capture });

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Column layout (lib/board-layout.ts): the column order, which columns are pinned (docked in ONE dock on the right,
  // outside the scroller), which pinned column the dock shows and whether it is collapsed. Browser-local (no saved views).
  const dock = useBoardDock({
    controller: useExperimentsColumnLayout(workspaceId),
    renderedIds: ALL_STATUSES,
    labelOf: (id) => COLUMN_BY_STATUS[id as ExperimentStatus].label,
    containerRef,
  });

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

    // A dock tab is resolved at drag end: its column may not be rendered, and moving the dragged card into an unrendered
    // column mid-drag unmounts it (and its menu) while dnd-kit is still tracking it.
    if (dockTabDropStatus(over.data.current)) return;

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

    // Dropped on a dock tab: that tab's status is the destination (the card was not moved there during the drag).
    const tabStatus = dockTabDropStatus<ExperimentStatus>(over.data.current);
    if (tabStatus) {
      if (tabStatus !== currentStatus) {
        setColumns((prev) => {
          const item = prev[currentStatus].find((i) => i.id === activeId);
          if (!item) return prev;
          return { ...prev, [currentStatus]: prev[currentStatus].filter((i) => i.id !== activeId), [tabStatus]: [...prev[tabStatus], { ...item, status: tabStatus }] };
        });
        startTransition(async () => {
          await moveExperiment(activeId, tabStatus, workspaceId, revalidatePathStr);
        });
      }
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

  /** Escape (or anything else that cancels the drag) puts the card back where the drag began. */
  function handleDragCancel(event: DragCancelEvent) {
    const activeId = event.active.id as string;
    const found = findStatus(columns, activeId);
    if (dragSourceStatus && found && found !== dragSourceStatus) {
      setColumns((prev) => {
        const item = prev[found].find((i) => i.id === activeId);
        if (!item) return prev;
        return {
          ...prev,
          [found]: prev[found].filter((i) => i.id !== activeId),
          [dragSourceStatus]: [...prev[dragSourceStatus], { ...item, status: dragSourceStatus }],
        };
      });
    }
    setActiveItem(null);
    setDragSourceStatus(null);
  }

  function renderColumn(status: ExperimentStatus, placement: "scroller" | "pinned") {
    const { label, accent } = COLUMN_BY_STATUS[status];
    return (
      <ExperimentColumn
        key={status}
        status={status}
        label={label}
        accent={accent}
        items={columns[status]}
        revalidatePathStr={revalidatePathStr}
        placement={placement}
        layoutControls={dock.layoutControlsFor(status)}
      />
    );
  }

  const dockTabs = dock.dockTabsFor((id) => columns[id as ExperimentStatus].length);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={dockAwareCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <Board
            label="Experiment board"
            fadeEnd={dock.dockedIds.length > 0}
            className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
          >
            <div
              data-slot="experiment-board-track"
              className={cn(
                "flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3",
                // Room for the scroller's tapered edge, so the last column at full scroll-end is not faded.
                dock.dockedIds.length > 0 && BOARD_FADE_END_TRACK_CLASS,
              )}
            >
              {dock.scrollerIds.map((status) => renderColumn(status as ExperimentStatus, "scroller"))}
            </div>
          </Board>
          {/* The dock sits OUTSIDE the horizontal scroller, so it stays put while the rest scroll and a drag from it never needs a mid-drag scroll. */}
          {dockTabs.length > 0 ? (
            <BoardDock
              tabs={dockTabs}
              activeId={dock.activeDockId}
              collapsed={!dock.dockOpen}
              onSelectTab={dock.selectDockTab}
              panel={dock.dockOpen && dock.activeDockId ? renderColumn(dock.activeDockId as ExperimentStatus, "pinned") : null}
              wrapTab={(tab, node, { panelOpen }) => (
                <DroppableDockTab columnId={tab.id} columnDroppableId={`column-${tab.id}`} panelOpen={panelOpen} slot="experiment-dock-tab-drop">
                  {node}
                </DroppableDockTab>
              )}
            />
          ) : null}
        </div>

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
