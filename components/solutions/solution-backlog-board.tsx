"use client";

import { useId, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Lightbulb } from "lucide-react";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { Board, BoardColumn, EmptyState } from "@/components/patterns";
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

export type SolutionBacklogItem = SolutionCardData & {
  opportunity: {
    id: string;
    title: string;
    squad: { id: string; name: string; color: string } | null;
  };
  /** Normalized option value of the active group field (null = Unspecified). Set only when grouped by a field. */
  fieldValue?: string | null;
};

const COLUMN_ACCENT: Record<SolutionStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  IDEA: "neutral",
  VALIDATED: "success",
  IN_DELIVERY: "info",
  SHIPPED: "warning",
  KILLED: "danger",
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
}: {
  status: SolutionStatus;
  items: SolutionBacklogItem[];
  ctx: CardContext;
}) {
  const labels = useLabels();
  const { setNodeRef, isOver } = useDroppable({ id: solutionBacklogColumnId(status), data: { status } });

  return (
    <BoardColumn
      data-slot="solution-backlog-column"
      data-status={status}
      title={SOLUTION_STATUS[status].label}
      count={items.length}
      accent={COLUMN_ACCENT[status]}
      // Fixed minimum width with horizontal scroll on the track: columns are
      // never squashed to fit the viewport.
      className="w-72 min-w-[280px] flex-none md:h-full md:overflow-hidden"
      bodyRef={setNodeRef}
      bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
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

export type SolutionBacklogProps = {
  solutions: SolutionBacklogItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  /** True when the workspace has an active Solution scoring model. */
  hasActiveScoringModel?: boolean;
  /** "Sort by score" view mode. Read-only: it disables dragging and never persists. */
  sortByScore?: boolean;
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
}: Omit<SolutionBacklogProps, "groupBy" | "squads" | "groupField">) {
  const labels = useLabels();
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/solutions`;
  const scoreSortActive = hasActiveScoringModel && sortByScore;
  const ctx: CardContext = { orgSlug, workspaceSlug, revalidatePathStr, showScore: hasActiveScoringModel };

  // Canonical (manual-order) state; score order is derived at render so
  // toggling it off restores the manual order with nothing re-persisted.
  const [columns, setColumns] = useState(() => buildSolutionBacklogColumns(solutions, false));
  const [activeItem, setActiveItem] = useState<SolutionBacklogItem | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<SolutionStatus | null>(null);
  const [, startTransition] = useTransition();

  // Stable across server and client, or dnd-kit's counter-based ids mismatch on hydration.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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
        await moveSolutionStatus(activeId, plan.status, moved.opportunity.id, workspaceId, revalidatePathStr);
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
          label={`${labels.solution.singular} backlog`}
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="solution-backlog-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {SOLUTION_STATUS_ORDER.map((status) => (
              <BacklogColumn key={status} status={status} items={visible[status]} ctx={ctx} />
            ))}
          </div>
        </Board>
        <DragOverlay>
          {activeItem ? (
            <div className="rotate-1 scale-105">{renderCard(activeItem, ctx)}</div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
