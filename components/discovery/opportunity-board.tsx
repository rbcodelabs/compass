"use client";

import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { useFlipAnimation } from "@/hooks/use-flip-animation";
import {
  DndContext,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
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
import { Lightbulb } from "lucide-react";
import {
  Board,
  BOARD_FADE_END_TRACK_CLASS,
  BoardColumn,
  BoardDock,
  EmptyState,
  PINNED_COLUMN_BODY_CLASS,
  PINNED_COLUMN_CLASS,
  type BoardColumnLayoutControls,
  type BoardDockTab,
} from "@/components/patterns";
import { DroppableDockTab, dockAwareCollisionDetection } from "@/components/patterns/board-dock-dnd";
import { useOpportunitiesColumnLayout } from "@/components/discovery/discovery-column-layout";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { canMoveColumn, collapseDock, moveColumn, setActiveColumn, togglePinColumn, type BoardLayout, type MoveDirection } from "@/lib/board-layout";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import { NewOpportunityButton } from "./new-opportunity-button";
import {
  moveOpportunity,
  reorderOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { orderCards, planDragEnd } from "@/lib/discovery-board-ordering";
import type { OpportunityStatus } from "@/lib/types";
import { DEFAULT_VISIBLE_COLUMNS, OPPORTUNITY_COLUMN_META } from "@/lib/saved-views/opportunity-columns";

const ALL_STATUSES: OpportunityStatus[] = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"];

type ColumnMap = Record<OpportunityStatus, OpportunityCardData[]>;

function buildColumnMap(
  opportunitiesByStatus: Record<OpportunityStatus, OpportunityCardData[]>
): ColumnMap {
  return ALL_STATUSES.reduce((acc, status) => {
    acc[status] = [...(opportunitiesByStatus[status] ?? [])].sort(
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
  showScore,
  dragEnabled,
  forcedVisible,
  placement = "scroller",
  layoutControls,
}: {
  forcedVisible: boolean;
  /** "pinned" is the dock's open panel: fixed width, no horizontal flex sizing. */
  placement?: "scroller" | "pinned";
  layoutControls?: BoardColumnLayoutControls;
  status: OpportunityStatus;
  label: string;
  accent: "neutral" | "info" | "warning" | "success";
  items: OpportunityCardData[];
  orgSlug: string;
  workspaceSlug: string;
  showScore: boolean;
  dragEnabled: boolean;
}) {
  const labels = useLabels();
  const pinned = placement === "pinned";
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
        title={`No ${labels.opportunity.lowerPlural} yet`}
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
      title={
        forcedVisible ? (
          <>
            {label}
            <span data-testid="forced-visible-marker" className="ml-1.5 text-xs font-normal text-text-subtle">
              hidden in view, has cards
            </span>
          </>
        ) : (
          label
        )
      }
      count={items.length}
      accent={accent}
      data-slot="opportunity-board-column"
      data-status={status}
      className={pinned ? PINNED_COLUMN_CLASS : "w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:overflow-hidden md:h-full"}
      layoutControls={layoutControls}
      bodyRef={setNodeRef}
      bodyClassName={`${pinned ? PINNED_COLUMN_BODY_CLASS : "min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"} ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
      footer={<NewOpportunityButton variant="column" status={status} />}
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
  /** True when the workspace has an active scoring model. */
  hasActiveScoringModel?: boolean;
  /** "Sort by score" view mode. Never persisted — see planDragEnd. */
  sortByScore?: boolean;
  /**
   * Which status columns to render (the resolved saved-view / URL hide state). Defaults to all of them. Only MEMBERSHIP
   * matters here: the order they appear in is the column layout's (see discovery-column-layout.tsx).
   */
  columnOrder?: readonly OpportunityStatus[];
  /** Columns the layout hides that are shown because they hold cards. */
  forcedVisibleColumns?: readonly OpportunityStatus[];
};

export function OpportunityBoard({
  opportunitiesByStatus,
  orgSlug,
  workspaceSlug,
  workspaceId,
  hasActiveScoringModel = false,
  sortByScore = false,
  columnOrder = DEFAULT_VISIBLE_COLUMNS,
  forcedVisibleColumns = [],
}: Props) {
  const labels = useLabels();
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/discovery`;

  // Score sort is only meaningful when there is a model to score against.
  const scoreSortActive = hasActiveScoringModel && sortByScore;
  const dragEnabled = !scoreSortActive;

  const [activeItem, setActiveItem] = useState<OpportunityCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<OpportunityStatus | null>(null);

  const [isPending, startTransition] = useTransition();

  // Follow the server (another user or an agent moved a card) except while the
  // user is dragging or a local write is in flight - see useServerSyncedState.
  const busy = activeItem !== null || dragSourceStatus !== null || isPending;
  const {
    state: columns,
    setState: setColumns,
    generation,
  } = useServerSyncedState(opportunitiesByStatus, buildColumnMap, busy);
  const { containerRef, capture } = useFlipAnimation(generation);
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "opportunities", paused: busy, onBeforeRefresh: capture });

  // Column layout (lib/board-layout.ts): the column order, which columns are pinned (docked in ONE dock on the right,
  // outside the scroller), which pinned column the dock shows and whether it is collapsed to its tab rail. Docking
  // applies from md up only; below md every column is an ordinary scroller column, in the same order. This board is the
  // Status grouping, the only one that docks (the custom-field board is a different component and ignores the layout).
  const isDesktop = useMediaQuery("(min-width: 768px)", false);
  const { layout, update: updateLayout } = useOpportunitiesColumnLayout(workspaceId);
  const rendered = new Set<string>(columnOrder);
  const orderedStatuses = layout.columnOrder.filter((id) => rendered.has(id)) as OpportunityStatus[];
  const isDocked = (id: string) => isDesktop && layout.pinnedColumnIds.includes(id);
  const dockedStatuses = orderedStatuses.filter(isDocked);
  const scrollerStatuses = orderedStatuses.filter((id) => !isDocked(id));
  // The stored active column may be one that isn't rendered (a hidden column): show the first rendered one then.
  const activeDockId = layout.activePinnedId && dockedStatuses.includes(layout.activePinnedId as OpportunityStatus) ? layout.activePinnedId : (dockedStatuses[0] ?? null);
  const dockOpen = activeDockId !== null && !layout.dockCollapsed;

  // Keyboard users keep their place: after a layout change the control that now represents the column gets focus.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    containerRef.current?.querySelector<HTMLElement>(`[data-column-control="${target}"]`)?.focus();
  }, [layout, containerRef]);
  const changeLayout = (transition: (current: BoardLayout) => BoardLayout, focus?: string) => {
    if (focus) pendingFocus.current = focus;
    updateLayout(transition);
  };

  // The active tab of an open dock closes it; any other tab shows its column and opens the dock.
  function selectDockTab(id: string) {
    changeLayout((current) => (dockOpen && id === activeDockId ? collapseDock(current) : setActiveColumn(current, id)), `${id}:tab`);
  }

  function layoutControlsFor(status: OpportunityStatus): BoardColumnLayoutControls {
    // A column moves among the columns rendered in its own region (the dock's tabs, or the scroller; everything on narrow screens).
    const scope = { among: (other: string) => rendered.has(other) && (!isDesktop || isDocked(other) === isDocked(status)) };
    const docked = isDocked(status);
    return {
      columnId: status,
      label: OPPORTUNITY_COLUMN_META[status].label,
      pinned: docked,
      pinnable: isDesktop,
      onTogglePin: () => changeLayout((l) => togglePinColumn(l, status), `${status}:pin`),
      canMoveLeft: canMoveColumn(layout, status, "left", scope),
      canMoveRight: canMoveColumn(layout, status, "right", scope),
      onMove: (direction: MoveDirection) => changeLayout((l) => moveColumn(l, status, direction, scope), `${status}:menu`),
      onCollapse: docked ? () => changeLayout(collapseDock, `${status}:tab`) : undefined,
    };
  }

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

  function renderColumn(status: OpportunityStatus, placement: "scroller" | "pinned") {
    return (
      <DiscoveryColumn
        key={status}
        status={status}
        label={OPPORTUNITY_COLUMN_META[status].label}
        accent={OPPORTUNITY_COLUMN_META[status].accent}
        forcedVisible={forcedVisibleColumns.includes(status)}
        items={visibleColumns[status]}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        showScore={hasActiveScoringModel}
        dragEnabled={dragEnabled}
        placement={placement}
        layoutControls={layoutControlsFor(status)}
      />
    );
  }

  const dockTabs: BoardDockTab[] = dockedStatuses.map((status) => ({
    id: status,
    title: OPPORTUNITY_COLUMN_META[status].label,
    count: visibleColumns[status].length,
  }));

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={dockAwareCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <Board
            label={`${labels.opportunity.singular} board`}
            fadeEnd={dockedStatuses.length > 0}
            className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
          >
            <div
              data-slot="opportunity-board-track"
              className={cn(
                "flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3",
                // Room for the scroller's tapered edge, so the last column at full scroll-end is not faded.
                dockedStatuses.length > 0 && BOARD_FADE_END_TRACK_CLASS,
              )}
            >
              {scrollerStatuses.map((status) => renderColumn(status, "scroller"))}
            </div>
          </Board>
          {/* The dock sits OUTSIDE the horizontal scroller, so it stays put while the rest scroll and a drag from it never needs a mid-drag scroll. */}
          {dockTabs.length > 0 ? (
            <BoardDock
              tabs={dockTabs}
              activeId={activeDockId}
              collapsed={!dockOpen}
              onSelectTab={selectDockTab}
              panel={dockOpen && activeDockId ? renderColumn(activeDockId as OpportunityStatus, "pinned") : null}
              wrapTab={(tab, node, { panelOpen }) => (
                <DroppableDockTab
                  columnId={tab.id}
                  columnDroppableId={`column-${tab.id}`}
                  panelOpen={panelOpen}
                  slot="opportunity-dock-tab-drop"
                >
                  {node}
                </DroppableDockTab>
              )}
            />
          ) : null}
        </div>

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
