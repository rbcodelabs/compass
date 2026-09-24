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
import { ChevronRight, Lightbulb } from "lucide-react";
import { Board, EmptyState } from "@/components/patterns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SolutionCard, type SolutionCardData } from "./solution-card";
import { AddSolutionForm } from "./add-solution-form";
import {
  moveSolutionStatus,
  reorderSolution,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { SOLUTION_STATUS, SOLUTION_STATUS_ORDER } from "@/lib/solution-status";
import { cn } from "@/lib/utils";
import type { SolutionStatus } from "@/lib/types";

export type SwimlaneOpportunity = {
  id: string;
  title: string;
  squad: { id: string; name: string; color: string } | null;
  solutions: SolutionCardData[];
};

type ColumnsMap = Record<string, SolutionCardData[]>;

/**
 * The rail that identifies each status column. With the columns themselves
 * unfilled, this plus the label and count is what makes a column legible —
 * so it maps to the same status accents the rest of the app uses rather than
 * inventing a palette.
 */
const STATUS_RAIL: Record<SolutionStatus, string> = {
  IDEA: "bg-status-neutral",
  VALIDATED: "bg-status-success",
  IN_DELIVERY: "bg-status-info",
  SHIPPED: "bg-primary",
  KILLED: "bg-status-danger",
};

// ─── Column id namespacing ─────────────────────────────────────────────────────
// A single DndContext spans every lane on this board, so plain status values
// ("IDEA", "VALIDATED", ...) can't be used as droppable ids the way
// OpportunityBoard uses "column-{status}" — every lane has an IDEA column, and
// they'd all collide. Namespacing with the owning opportunityId keeps each
// lane's columns distinct. The "::" separator can't appear in a UUID, so a
// bare card id (no separator) is never mistaken for a column id.
const COLUMN_SEP = "::";

export function makeColumnId(opportunityId: string, status: SolutionStatus): string {
  return `${opportunityId}${COLUMN_SEP}${status}`;
}

export function parseColumnId(id: string): { opportunityId: string; status: SolutionStatus } | null {
  const sepIndex = id.indexOf(COLUMN_SEP);
  if (sepIndex === -1) return null;
  const opportunityId = id.slice(0, sepIndex);
  const status = id.slice(sepIndex + COLUMN_SEP.length);
  if (!SOLUTION_STATUS_ORDER.includes(status as SolutionStatus)) return null;
  return { opportunityId, status: status as SolutionStatus };
}

function buildColumnsMap(opportunities: SwimlaneOpportunity[]): ColumnsMap {
  const map: ColumnsMap = {};
  for (const opportunity of opportunities) {
    for (const status of SOLUTION_STATUS_ORDER) {
      map[makeColumnId(opportunity.id, status)] = opportunity.solutions
        .filter((s) => s.status === status)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    }
  }
  return map;
}

function findColumnId(columns: ColumnsMap, itemId: string): string | null {
  for (const [columnId, items] of Object.entries(columns)) {
    if (items.some((i) => i.id === itemId)) return columnId;
  }
  return null;
}

// ─── Drag-end classification ────────────────────────────────────────────────────
// The one rule this board enforces beyond OpportunityBoard's plain
// cross-column move: a drop is only ever persisted when it lands in a column
// belonging to the *same* Opportunity it started in. This is generic across
// every lane pair (not a single special-cased column, the way
// roadmap-board.tsx only guards its LAUNCHING horizon), which is what makes
// it safe as lanes are added.
export type DragOutcome =
  | { kind: "none" }
  | { kind: "reorder" }
  | { kind: "move"; opportunityId: string; status: SolutionStatus }
  | { kind: "cross-lane-revert"; sourceOpportunityId: string; sourceStatus: SolutionStatus };

export function classifyDragEnd(sourceColumnId: string, destColumnId: string): DragOutcome {
  if (sourceColumnId === destColumnId) return { kind: "reorder" };

  const source = parseColumnId(sourceColumnId);
  const dest = parseColumnId(destColumnId);
  if (!source || !dest) return { kind: "none" };

  if (source.opportunityId !== dest.opportunityId) {
    return {
      kind: "cross-lane-revert",
      sourceOpportunityId: source.opportunityId,
      sourceStatus: source.status,
    };
  }

  return { kind: "move", opportunityId: dest.opportunityId, status: dest.status };
}

// ─── Column ───────────────────────────────────────────────────────────────────

function SwimlaneColumn({
  opportunityId,
  status,
  items,
  revalidatePathStr,
}: {
  opportunityId: string;
  status: SolutionStatus;
  items: SolutionCardData[];
  revalidatePathStr: string;
}) {
  const columnId = makeColumnId(opportunityId, status);
  const itemIds = items.map((i) => i.id);
  const { setNodeRef, isOver } = useDroppable({
    id: columnId,
    data: { opportunityId, status },
  });

  return (
    /*
      Deliberately NOT `BoardColumn`. That component is built for a top-level
      board column: a filled, bordered, rounded box that owns its own scroll
      region and a sticky header. Nested in a lane, every one of those is
      wrong — and adapting it was what produced the stacked-cards look
      (lane card > filled column box > solution card, three bordered
      surfaces). A lane column is a different thing: the lane is the only
      surface, and each column is identified by a status rail, a label and a
      count rather than by being its own box.
    */
    /*
      min-w tuned so all five statuses fit at the 1280 desktop breakpoint
      (≈1036px of lane interior once the sidebar and lane padding are taken
      out: 5 × 184 + 4 × 12 gap = 968). Seeing the whole lifecycle at once is
      the point of this view, so it should not need horizontal scrolling at
      the primary width — narrower viewports still scroll.
    */
    <div
      // Stable hooks for tests. Previously the e2e spec located a column as
      // the `<section>` BoardColumn happened to render, which broke the moment
      // this became a purpose-built element. data-slot matches the convention
      // used elsewhere (data-slot="card", "collapsible", "sheet-content").
      data-slot="swimlane-column"
      data-status={status}
      data-opportunity={opportunityId}
      className="flex w-[100cqw] min-w-0 flex-none flex-col md:w-auto md:min-w-[184px] md:flex-1"
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className={cn("h-3 w-[3px] shrink-0 rounded-full", STATUS_RAIL[status])}
        />
        <h4 className="truncate text-xs font-semibold tracking-wide text-text-secondary uppercase">
          {SOLUTION_STATUS[status].label}
        </h4>
        <span
          aria-label={`${items.length} items`}
          className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle"
        >
          {items.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex flex-1 flex-col gap-2 rounded-lg",
          // The drop target only draws itself during a drag. That's when a
          // column needs to read as an explicit bucket; the rest of the time
          // the rail + label carry it without adding chrome.
          isOver && "bg-primary/5 ring-2 ring-inset ring-ring/25"
        )}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            // Not the shared EmptyState: `compact` is still min-h-32 plus an
            // icon bubble, and most opportunities have no solutions, so five
            // across a lane turned one empty opportunity into ~200px of dashed
            // boxes. A lane needs a slim hint that is itself the drop zone.
            <div
              className={cn(
                "flex min-h-16 flex-1 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs",
                isOver
                  ? "border-border-interactive text-text-secondary"
                  : "border-border-default text-text-subtle"
              )}
            >
              No solutions
            </div>
          ) : (
            items.map((solution) => (
              // No status badge: this card already sits in its status's column,
              // and the badge would steal width from the title.
              <SolutionCard
                key={solution.id}
                solution={solution}
                revalidatePathStr={revalidatePathStr}
                showStatus={false}
              />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
}

// ─── Lane ───────────────────────────────────────────────────────────────────────

function SwimlaneRow({
  opportunity,
  columns,
  isCollapsed,
  onOpenChange,
  revalidatePathStr,
}: {
  opportunity: SwimlaneOpportunity;
  columns: ColumnsMap;
  isCollapsed: boolean;
  onOpenChange: (open: boolean) => void;
  revalidatePathStr: string;
}) {
  const totalCount = SOLUTION_STATUS_ORDER.reduce(
    (sum, status) => sum + (columns[makeColumnId(opportunity.id, status)]?.length ?? 0),
    0
  );

  return (
    <Collapsible
      // shrink-0 is load-bearing. Lanes are flex children of a height-capped
      // `flex-col overflow-y-auto` container, so the default flex-shrink:1 let
      // flexbox squash each lane *below its content height*. The content then
      // spilled out of the lane's box — which is what made column backgrounds
      // paint outside the lane's rounded border and column headers collide
      // with the lane header above. Natural height + let the parent scroll.
      //
      // overflow-hidden then keeps the horizontally scrolling Board (and each
      // column's background) inside the lane's rounded corners.
      //
      // The lane is the ONLY surface in here: its columns are unfilled and
      // unbordered (see SwimlaneColumn), so the card + the solution cards are
      // the two levels of chrome, not four.
      className="group shrink-0 overflow-hidden rounded-xl border border-border-default bg-surface-panel shadow-[var(--shadow-card)]"
      open={!isCollapsed}
      onOpenChange={onOpenChange}
    >
      {/*
        Deliberately a plain button, not <Button variant="ghost">. The ghost
        variant carries `aria-expanded:bg-muted`, and `--surface-inset` IS
        `--muted` — so an expanded lane painted its header in the exact same
        fill as the columns below it, as a `rounded-lg` box inset inside the
        lane's `rounded-xl` card. That read as a separate card stacked on top
        of the lane rather than the lane's own header. That `aria-expanded`
        fill exists for dropdown triggers; a group header is not one.

        Square corners + the lane's overflow-hidden mean this row is clipped
        to the card's top radius, so it reads as the card's own header band.
      */}
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-inset/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
          />
        }
      >
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-open:rotate-90" />
        {opportunity.squad && (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: opportunity.squad.color }}
            title={opportunity.squad.name}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-left font-medium">{opportunity.title}</span>
        <span className="shrink-0 text-xs text-text-subtle">
          {totalCount} {totalCount === 1 ? "solution" : "solutions"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/*
          border-t separates the lane header from its columns, and pt-3 gives
          them room — previously the columns butted straight against the
          trigger with no gap at all.
        */}
        <div className="flex flex-col gap-3 border-t border-border-default px-3 pt-3 pb-3">
          {/* items-stretch so every column shares the tallest column's height,
              which is what keeps the unfilled columns reading as one row. */}
          <Board
            label={`${opportunity.title} solutions`}
            className="items-stretch gap-3 pb-0"
          >
            {SOLUTION_STATUS_ORDER.map((status) => (
              <SwimlaneColumn
                key={status}
                opportunityId={opportunity.id}
                status={status}
                items={columns[makeColumnId(opportunity.id, status)] ?? []}
                revalidatePathStr={revalidatePathStr}
              />
            ))}
          </Board>
          <AddSolutionForm opportunityId={opportunity.id} revalidatePathStr={revalidatePathStr} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

type Props = {
  opportunities: SwimlaneOpportunity[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
};

export function SolutionSwimlaneBoard({ opportunities, orgSlug, workspaceSlug, workspaceId }: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/discovery`;

  const [columns, setColumns] = useState<ColumnsMap>(() => buildColumnsMap(opportunities));
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [activeItem, setActiveItem] = useState<SolutionCardData | null>(null);
  const [dragSourceColumnId, setDragSourceColumnId] = useState<string | null>(null);

  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function setLaneCollapsed(opportunityId: string, open: boolean) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (open) next.delete(opportunityId);
      else next.add(opportunityId);
      return next;
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    const columnId = findColumnId(columns, id);
    if (!columnId) return;
    setActiveItem(columns[columnId].find((i) => i.id === id) ?? null);
    setDragSourceColumnId(columnId);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const sourceColumnId = findColumnId(columns, activeId);
    if (!sourceColumnId) return;

    const destColumnId = parseColumnId(overId) ? overId : (findColumnId(columns, overId) ?? sourceColumnId);

    if (sourceColumnId === destColumnId) return;

    setColumns((prev) => {
      const item = prev[sourceColumnId]?.find((i) => i.id === activeId);
      if (!item) return prev;

      const dest = parseColumnId(destColumnId);
      const updatedItem = dest ? { ...item, status: dest.status } : item;

      let destItems = (prev[destColumnId] ?? []).filter((i) => i.id !== activeId);
      if (parseColumnId(overId)) {
        destItems = [...destItems, updatedItem];
      } else {
        const overIndex = destItems.findIndex((i) => i.id === overId);
        if (overIndex >= 0) {
          destItems = [...destItems.slice(0, overIndex), updatedItem, ...destItems.slice(overIndex)];
        } else {
          destItems = [...destItems, updatedItem];
        }
      }

      return {
        ...prev,
        [sourceColumnId]: (prev[sourceColumnId] ?? []).filter((i) => i.id !== activeId),
        [destColumnId]: destItems,
      };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveItem(null);

    if (!over) {
      setDragSourceColumnId(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const currentColumnId = findColumnId(columns, activeId);
    if (!currentColumnId || !dragSourceColumnId) {
      setDragSourceColumnId(null);
      return;
    }

    const outcome = classifyDragEnd(dragSourceColumnId, currentColumnId);

    if (outcome.kind === "cross-lane-revert") {
      // Snap back to the source lane/status — reparenting a Solution across
      // Opportunities is a deliberate panel action, never a side effect of a
      // drag on this board.
      const sourceColumnId = dragSourceColumnId;
      setColumns((prev) => {
        const item = prev[currentColumnId]?.find((i) => i.id === activeId);
        if (!item) return prev;
        const reverted = { ...item, status: outcome.sourceStatus };
        return {
          ...prev,
          [currentColumnId]: prev[currentColumnId].filter((i) => i.id !== activeId),
          [sourceColumnId]: [...(prev[sourceColumnId] ?? []).filter((i) => i.id !== activeId), reverted],
        };
      });
    } else if (outcome.kind === "move") {
      startTransition(async () => {
        await moveSolutionStatus(activeId, outcome.status, outcome.opportunityId, workspaceId, revalidatePathStr);
      });
    } else if (outcome.kind === "reorder" && overId !== activeId) {
      const columnItems = columns[currentColumnId];
      const oldIndex = columnItems.findIndex((i) => i.id === activeId);
      const newIndex = columnItems.findIndex((i) => i.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(columnItems, oldIndex, newIndex).map((item, idx) => ({
          ...item,
          sortOrder: idx,
        }));
        setColumns((prev) => ({ ...prev, [currentColumnId]: reordered }));

        startTransition(async () => {
          await reorderSolution(activeId, newIndex, revalidatePathStr);
        });
      }
    }

    setDragSourceColumnId(null);
  }

  if (opportunities.length === 0) {
    return (
      <EmptyState
        icon={<Lightbulb className="size-5" />}
        title="No opportunities yet"
        description="Create an Opportunity to start adding Solutions to it."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {opportunities.map((opportunity) => (
          <SwimlaneRow
            key={opportunity.id}
            opportunity={opportunity}
            columns={columns}
            isCollapsed={collapsedIds.has(opportunity.id)}
            onOpenChange={(open) => setLaneCollapsed(opportunity.id, open)}
            revalidatePathStr={revalidatePathStr}
          />
        ))}

        <DragOverlay>
          {activeItem ? (
            <div className="rotate-1 scale-105">
              {/* Matches the in-column cards so the card doesn't change shape mid-drag. */}
              <SolutionCard solution={activeItem} revalidatePathStr={revalidatePathStr} showStatus={false} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
