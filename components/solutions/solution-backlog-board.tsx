"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { useFlipAnimation } from "@/hooks/use-flip-animation";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  type CollisionDetection,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Lightbulb } from "lucide-react";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
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
import { useSolutionsColumnLayout } from "@/components/solutions/solutions-column-layout";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { canMoveColumn, collapseDock, moveColumn, setActiveColumn, togglePinColumn, type BoardLayout, type MoveDirection } from "@/lib/board-layout";
import { SolutionCard, type SolutionCardData } from "@/components/discovery/solution-card";
import { moveSolutionStatus } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { SOLUTION_STATUS, SOLUTION_STATUS_ORDER } from "@/lib/solution-status";
import {
  buildSolutionBacklogColumns,
  parseSolutionBacklogColumnId,
  planSolutionDrop,
  solutionBacklogColumnId,
  type SolutionBacklogColumns,
} from "@/lib/solution-backlog";
import {
  buildSolutionGroups,
  solutionGroupByFieldId,
  type SolutionGroupBy,
  type SolutionGroupColumn,
} from "@/lib/solution-backlog-grouping";
import type { SelectOption, SolutionStatus } from "@/lib/types";
import { announceRoadmapSync } from "@/lib/ui/roadmap-sync-toast";
import { SOLUTION_COLUMN_ACCENT } from "@/lib/saved-views/solution-columns";

export type SolutionBacklogItem = SolutionCardData & {
  opportunity: {
    id: string;
    title: string;
    squad: { id: string; name: string; color: string } | null;
  };
  /** Normalized option value of the active group field (null = Unspecified). Set only when grouped by a field. */
  fieldValue?: string | null;
};

function findStatus(columns: SolutionBacklogColumns<SolutionBacklogItem>, id: string): SolutionStatus | null {
  for (const status of SOLUTION_STATUS_ORDER) {
    if (columns[status].some((item) => item.id === id)) return status;
  }
  return null;
}

type CardContext = {
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  showScore: boolean;
};

function renderCard(item: SolutionBacklogItem, ctx: CardContext, draggable = true) {
  const href = `/${ctx.orgSlug}/${ctx.workspaceSlug}/discovery/${item.opportunity.id}`;
  return (
    <SolutionCard
      key={item.id}
      solution={item}
      revalidatePathStr={ctx.revalidatePathStr}
      // The column is the status, so the badge would only steal title width.
      showStatus={false}
      showScore={ctx.showScore}
      draggable={draggable}
      scoringHref={href}
      parent={{ title: item.opportunity.title, href, squad: item.opportunity.squad }}
    />
  );
}

function BacklogColumn({
  status,
  items,
  ctx,
  forcedVisible = false,
  placement = "scroller",
  layoutControls,
}: {
  status: SolutionStatus;
  items: SolutionBacklogItem[];
  ctx: CardContext;
  forcedVisible?: boolean;
  /** "pinned" is the dock's open panel: fixed width, no horizontal flex sizing. */
  placement?: "scroller" | "pinned";
  layoutControls?: BoardColumnLayoutControls;
}) {
  const labels = useLabels();
  const pinned = placement === "pinned";
  const { setNodeRef, isOver } = useDroppable({ id: solutionBacklogColumnId(status), data: { status } });

  return (
    <BoardColumn
      data-slot="solution-backlog-column"
      data-status={status}
      title={SOLUTION_STATUS[status].label}
      data-forced-visible={forcedVisible ? "true" : undefined}
      count={items.length}
      accent={SOLUTION_COLUMN_ACCENT[status]}
      // Fixed minimum width with horizontal scroll on the track: columns are
      // never squashed to fit the viewport.
      className={pinned ? PINNED_COLUMN_CLASS : "w-72 min-w-[280px] flex-none md:h-full md:overflow-hidden"}
      layoutControls={layoutControls}
      bodyRef={setNodeRef}
      bodyClassName={`${pinned ? PINNED_COLUMN_BODY_CLASS : "min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"} ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.length === 0 ? (
          <EmptyState
            compact
            icon={<Lightbulb className="size-4" />}
            title={`No ${labels.solution.lowerPlural}`}
            className={isOver ? "border-border-interactive" : undefined}
          />
        ) : (
          items.map((item) => renderCard(item, ctx))
        )}
      </SortableContext>
    </BoardColumn>
  );
}

/**
 * A tab only counts as a drop target when the pointer is actually on it: closestCenter alone lets a tall column body beat
 * a small tab, because it measures the dragged card's centre rather than the pointer.
 */
const collisionDetection: CollisionDetection = (args) => {
  const onTab = pointerWithin(args).find((hit) => args.droppableContainers.find((c) => c.id === hit.id)?.data.current?.dockTab);
  return onTab ? [onTab] : closestCenter(args);
};

/**
 * A dock tab, which is also a drop target: a card dropped on it lands in that status exactly as a drop on the open column
 * would, so it registers under the column's own `column-<status>` id with `{ status }` data, which the drag handlers
 * already parse. While that column is the open panel the panel owns that id (two droppables must not share one), so the
 * tab is disabled and parked under an id nothing refers to; the wrapper element stays put so the tab keeps focus.
 */
function DroppableDockTab({ status, panelOpen, children }: { status: SolutionStatus; panelOpen: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: panelOpen ? `dock-tab-${status}` : solutionBacklogColumnId(status),
    data: { status, dockTab: true },
    disabled: panelOpen,
  });
  return (
    <div ref={setNodeRef} data-slot="solution-dock-tab-drop" data-status={status} className={cn("h-fit rounded-xl", isOver && "ring-2 ring-ring/40")}>
      {children}
    </div>
  );
}

export type SolutionBacklogProps = {
  solutions: SolutionBacklogItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  /** True when the workspace has an active Solution scoring model. */
  hasActiveScoringModel?: boolean;
  /** "Sort by score" view mode. Read-only: it disables dragging and never persists. */
  sortByScore?: boolean;
  /**
   * Which status columns to render (the resolved saved-view / URL hide state). Defaults to all of them. Only MEMBERSHIP
   * matters here: the order they appear in is the column layout's (see solutions-column-layout.tsx).
   */
  columnOrder?: readonly SolutionStatus[];
  /** Columns the layout hides that are shown because they hold cards. */
  forcedVisibleColumns?: readonly SolutionStatus[];
  /** Column grouping. Defaults to Status, the only grouping whose cards can be dragged. */
  groupBy?: SolutionGroupBy;
  /** The workspace squads, for the Squad grouping. */
  squads?: { id: string; name: string; color: string }[];
  /** The resolved group field, required for a `field:<id>` grouping. */
  groupField?: { id: string; name: string; options: SelectOption[] } | null;
};

/**
 * Dispatches between the Status board (drag to change status, optimistic) and
 * the read-only grouped board. They are separate components so each keeps its
 * own hooks unconditionally.
 */
export function SolutionBacklogBoard({ groupBy = "status", squads = [], groupField = null, ...props }: SolutionBacklogProps) {
  if (groupBy === "status") return <StatusBacklogBoard {...props} />;
  return <GroupedBacklogBoard {...props} groupBy={groupBy} squads={squads} groupField={groupField} />;
}

function EmptyBacklog() {
  const labels = useLabels();
  return (
    <EmptyState
      icon={<Lightbulb className="size-5" />}
      title={`No ${labels.solution.lowerPlural} found`}
      description={`${labels.solution.plural} are added from ${labels.opportunity.lower} pages in Discovery. Or adjust the filters.`}
    />
  );
}

function groupByNoun(groupBy: SolutionGroupBy, groupField: { name: string } | null, labels: ReturnType<typeof useLabels>) {
  if (groupBy === "squad") return "squad";
  if (groupBy === "opportunity") return labels.opportunity.lower;
  return groupField?.name ?? "group";
}

function GroupedBacklogBoard({
  solutions,
  orgSlug,
  workspaceSlug,
  hasActiveScoringModel = false,
  sortByScore = false,
  groupBy,
  squads,
  groupField,
}: Omit<SolutionBacklogProps, "workspaceId" | "groupBy" | "squads" | "groupField"> & {
  groupBy: SolutionGroupBy;
  squads: { id: string; name: string; color: string }[];
  groupField: { id: string; name: string; options: SelectOption[] } | null;
}) {
  const labels = useLabels();
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/solutions`;
  const ctx: CardContext = { orgSlug, workspaceSlug, revalidatePathStr, showScore: hasActiveScoringModel };
  const dndId = useId();
  // Read-only and derived straight from props, so a refresh is all it needs.
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "solutions" });
  // A stale field id is resolved to Status by the page; defend anyway so a bad
  // prop never renders a board with no columns.
  const usable = groupBy !== "status" && (solutionGroupByFieldId(groupBy) === null || groupField !== null);
  const groups: SolutionGroupColumn<SolutionBacklogItem>[] = usable
    ? buildSolutionGroups(solutions, groupBy, { squads, field: groupField }, hasActiveScoringModel && sortByScore)
    : [];

  if (solutions.length === 0 || groups.length === 0) return <EmptyBacklog />;

  const noun = groupByNoun(groupBy, groupField, labels);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <p data-slot="solution-backlog-readonly-note" className="shrink-0 px-3 pt-3 text-xs text-text-subtle sm:px-4">
        {`Grouped by ${noun}. This view is read-only: ${labels.solution.lowerPlural} cannot be dragged between ${noun} columns. Use the card menu to change status, or switch back to Status to drag.`}
      </p>
      {/* No handlers: the cards register with dnd-kit but nothing can drag. */}
      <DndContext id={dndId}>
        <Board
          label={`${labels.solution.singular} backlog grouped by ${noun}`}
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="solution-backlog-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {groups.map((group) => (
              <BoardColumn
                key={group.id}
                data-slot="solution-backlog-column"
                data-group={group.id}
                title={
                  <span className="inline-flex items-center gap-1.5">
                    {group.color && (
                      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                    )}
                    <span className="truncate">{group.label}</span>
                  </span>
                }
                count={group.items.length}
                accent="neutral"
                className="w-72 min-w-[280px] flex-none md:h-full md:overflow-hidden"
                bodyClassName="min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"
              >
                <SortableContext items={group.items.map((item) => item.id)} strategy={verticalListSortingStrategy} disabled>
                  {group.items.length === 0 ? (
                    <EmptyState compact icon={<Lightbulb className="size-4" />} title={`No ${labels.solution.lowerPlural}`} />
                  ) : (
                    group.items.map((item) => renderCard(item, ctx, false))
                  )}
                </SortableContext>
              </BoardColumn>
            ))}
          </div>
        </Board>
      </DndContext>
    </div>
  );
}

function StatusBacklogBoard({
  solutions,
  orgSlug,
  workspaceSlug,
  workspaceId,
  hasActiveScoringModel = false,
  sortByScore = false,
  columnOrder = SOLUTION_STATUS_ORDER,
  forcedVisibleColumns = [],
}: Omit<SolutionBacklogProps, "groupBy" | "squads" | "groupField">) {
  const labels = useLabels();
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/solutions`;
  const scoreSortActive = hasActiveScoringModel && sortByScore;
  const ctx: CardContext = { orgSlug, workspaceSlug, revalidatePathStr, showScore: hasActiveScoringModel };

  // Canonical (manual-order) state; score order is derived at render so
  // toggling it off restores the manual order with nothing re-persisted.
  const [activeItem, setActiveItem] = useState<SolutionBacklogItem | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<SolutionStatus | null>(null);
  const [isPending, startTransition] = useTransition();

  // Follow the server unless a drag or local write is in flight (see useServerSyncedState).
  const busy = activeItem !== null || dragSourceStatus !== null || isPending;
  const {
    state: columns,
    setState: setColumns,
    generation,
  } = useServerSyncedState(solutions, (source) => buildSolutionBacklogColumns(source, false), busy);
  const { containerRef, capture } = useFlipAnimation(generation);
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "solutions", paused: busy, onBeforeRefresh: capture });

  // Stable across server and client, or dnd-kit's counter-based ids mismatch on hydration.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Column layout (lib/board-layout.ts): the column order, which columns are pinned (docked in ONE dock on the right,
  // outside the scroller), which pinned column the dock shows and whether it is collapsed to its tab rail. Docking
  // applies from md up only; below md every column is an ordinary scroller column, in the same order.
  const isDesktop = useMediaQuery("(min-width: 768px)", false);
  const { layout, update: updateLayout } = useSolutionsColumnLayout(workspaceId);
  const rendered = new Set<string>(columnOrder);
  const orderedStatuses = layout.columnOrder.filter((id) => rendered.has(id)) as SolutionStatus[];
  const isDocked = (id: string) => isDesktop && layout.pinnedColumnIds.includes(id);
  const dockedStatuses = orderedStatuses.filter(isDocked);
  const scrollerStatuses = orderedStatuses.filter((id) => !isDocked(id));
  // The stored active column may be one that isn't rendered (a hidden column): show the first rendered one then.
  const activeDockId = layout.activePinnedId && dockedStatuses.includes(layout.activePinnedId as SolutionStatus) ? layout.activePinnedId : (dockedStatuses[0] ?? null);
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

  // The active tab of an open dock closes it; any other tab shows its column and opens the dock. Tabs are only for pinned
  // columns, so the layout always lists them as pinned.
  function selectDockTab(id: string) {
    changeLayout((current) => (dockOpen && id === activeDockId ? collapseDock(current) : setActiveColumn(current, id)), `${id}:tab`);
  }

  function layoutControlsFor(status: SolutionStatus): BoardColumnLayoutControls {
    // A column moves among the columns rendered in its own region (the dock's tabs, or the scroller; everything on narrow screens).
    const scope = { among: (other: string) => rendered.has(other) && (!isDesktop || isDocked(other) === isDocked(status)) };
    const docked = isDocked(status);
    return {
      columnId: status,
      label: SOLUTION_STATUS[status].label,
      pinned: docked,
      pinnable: isDesktop,
      onTogglePin: () => changeLayout((l) => togglePinColumn(l, status), `${status}:pin`),
      canMoveLeft: canMoveColumn(layout, status, "left", scope),
      canMoveRight: canMoveColumn(layout, status, "right", scope),
      onMove: (direction: MoveDirection) => changeLayout((l) => moveColumn(l, status, direction, scope), `${status}:menu`),
      onCollapse: docked ? () => changeLayout(collapseDock, `${status}:tab`) : undefined,
    };
  }

  function handleDragStart(event: DragStartEvent) {
    if (scoreSortActive) return;
    const id = event.active.id as string;
    const status = findStatus(columns, id);
    if (!status) return;
    setActiveItem(columns[status].find((item) => item.id === id) ?? null);
    setDragSourceStatus(status);
  }

  function handleDragOver(event: DragOverEvent) {
    if (scoreSortActive) return;
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    const source = findStatus(columns, activeId);
    if (!source) return;
    const dest = parseSolutionBacklogColumnId(overId) ?? findStatus(columns, overId) ?? source;
    if (source === dest) return;

    setColumns((prev) => {
      const item = prev[source].find((i) => i.id === activeId);
      if (!item) return prev;
      const moved = { ...item, status: dest };
      const destItems = prev[dest].filter((i) => i.id !== activeId);
      const overIndex = destItems.findIndex((i) => i.id === overId);
      return {
        ...prev,
        [source]: prev[source].filter((i) => i.id !== activeId),
        [dest]: overIndex >= 0 ? [...destItems.slice(0, overIndex), moved, ...destItems.slice(overIndex)] : [...destItems, moved],
      };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = event.active.id as string;
    const current = findStatus(columns, activeId);
    const plan = scoreSortActive || !event.over ? { kind: "none" as const } : planSolutionDrop(dragSourceStatus, current);
    const moved = current ? columns[current].find((item) => item.id === activeId) : null;

    if (plan.kind === "move" && moved) {
      startTransition(async () => {
        const result = await moveSolutionStatus(activeId, plan.status, moved.opportunity.id, workspaceId, revalidatePathStr);
        announceRoadmapSync(result.roadmapSync);
      });
    } else if (dragSourceStatus && current && dragSourceStatus !== current) {
      // Dropped outside any column: snap back to where the drag began.
      setColumns((prev) => {
        const item = prev[current].find((i) => i.id === activeId);
        if (!item) return prev;
        return {
          ...prev,
          [current]: prev[current].filter((i) => i.id !== activeId),
          [dragSourceStatus]: [...prev[dragSourceStatus], { ...item, status: dragSourceStatus }],
        };
      });
    }

    setActiveItem(null);
    setDragSourceStatus(null);
  }

  const visible = scoreSortActive
    ? buildSolutionBacklogColumns(SOLUTION_STATUS_ORDER.flatMap((status) => columns[status]), true)
    : columns;

  if (SOLUTION_STATUS_ORDER.every((status) => columns[status].length === 0)) {
    return <EmptyBacklog />;
  }

  function renderColumn(status: SolutionStatus, placement: "scroller" | "pinned") {
    return (
      <BacklogColumn
        key={status}
        status={status}
        items={visible[status]}
        ctx={ctx}
        forcedVisible={forcedVisibleColumns.includes(status)}
        placement={placement}
        layoutControls={layoutControlsFor(status)}
      />
    );
  }

  const dockTabs: BoardDockTab[] = dockedStatuses.map((status) => ({
    id: status,
    title: SOLUTION_STATUS[status].label,
    count: visible[status].length,
  }));

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <Board
            label={`${labels.solution.singular} backlog`}
            fadeEnd={dockedStatuses.length > 0}
            className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
          >
            <div
              data-slot="solution-backlog-track"
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
              panel={dockOpen && activeDockId ? renderColumn(activeDockId as SolutionStatus, "pinned") : null}
              wrapTab={(tab, node, { panelOpen }) => (
                <DroppableDockTab status={tab.id as SolutionStatus} panelOpen={panelOpen}>{node}</DroppableDockTab>
              )}
            />
          ) : null}
        </div>
        <DragOverlay>
          {activeItem ? (
            <div className="rotate-1 scale-105">{renderCard(activeItem, ctx)}</div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
