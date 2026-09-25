"use client";

import { useMemo, useRef, useState, type ReactNode, useId } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lightbulb } from "lucide-react";
import { Board, BoardColumn, EmptyState } from "@/components/patterns";
import { EntityCard } from "@/components/patterns/entity-card";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { setOpportunityFieldValue } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { fieldColumns, type FieldColumn } from "@/lib/opportunity-field-board";
import type { SelectOption, SquadData } from "@/lib/types";

/**
 * The Discovery board grouped by an Opportunity single-select custom field —
 * a card-sort surface (e.g. MoSCoW). Deliberately separate from
 * OpportunityBoard: dragging here only ever sets or clears the field value.
 * There is no within-column ordering (sortOrder is a Status-board concept) and
 * no create footer, and status/archive state are never written.
 *
 * Reuses the Board/BoardColumn primitives and the same track/column sizing as
 * the Status board so mobile columns keep the #290 scroll and touch-pan
 * behaviour: only the drag handle is `touch-none`, never the card.
 */

export type FieldBoardOpportunity = {
  id: string;
  title: string;
  customerSegment: string | null;
  squad?: SquadData | null;
  _count: { solutions: number; evidence: number };
  /** Normalized option value, or null for Unspecified (absent or stale). */
  value: string | null;
};

type Props = {
  field: { id: string; name: string; options: SelectOption[] };
  opportunities: FieldBoardOpportunity[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
};

const columnDroppableId = (column: FieldColumn) => `field-column-${column.id}`;

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function OpportunityFieldBoard({ field, opportunities, orgSlug, workspaceSlug, workspaceId }: Props) {
  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;
  const columns = useMemo(() => fieldColumns(field.options), [field.options]);

  const [values, setValues] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(opportunities.map((opportunity) => [opportunity.id, opportunity.value]))
  );
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  // Latest request per card, so a stale failure can't roll back a newer move.
  const latestRequest = useRef(new Map<string, number>());
  const requestCounter = useRef(0);

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  const columnFor = (value: string | null) => columns.find((column) => column.value === value) ?? columns[0];

  async function move(opportunity: FieldBoardOpportunity, destination: FieldColumn) {
    const previous = values[opportunity.id] ?? null;
    if (previous === destination.value) return;

    const request = ++requestCounter.current;
    latestRequest.current.set(opportunity.id, request);
    setError(null);
    setValues((current) => ({ ...current, [opportunity.id]: destination.value }));
    setPendingIds((current) => new Set(current).add(opportunity.id));
    setAnnouncement(`Moved ${opportunity.title} to ${destination.label}.`);

    try {
      await setOpportunityFieldValue(opportunity.id, field.id, destination.value, workspaceId, boardPath);
    } catch {
      const previousColumn = columnFor(previous);
      if (latestRequest.current.get(opportunity.id) === request) {
        setValues((current) => ({ ...current, [opportunity.id]: previous }));
      }
      setAnnouncement("");
      setError(
        `Couldn't move "${opportunity.title}" to ${destination.label}. It is back in ${previousColumn.label}. Please try again.`
      );
    } finally {
      if (latestRequest.current.get(opportunity.id) === request) {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(opportunity.id);
          return next;
        });
      }
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const opportunity = opportunities.find((candidate) => candidate.id === event.active.id);
    const destination = event.over?.data.current?.column as FieldColumn | undefined;
    if (opportunity && destination) void move(opportunity, destination);
  }

  const activeOpportunity = activeId ? opportunities.find((opportunity) => opportunity.id === activeId) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <div className="shrink-0 space-y-2 px-3 pt-3 sm:px-4">
        <p className="text-xs text-text-subtle">
          Drag between columns to change {field.name}. Return to Unspecified to clear it.
        </p>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <Board
          label={`Opportunity board grouped by ${field.name}`}
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="opportunity-field-board-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {columns.map((column) => (
              <FieldBoardColumn
                key={column.id}
                column={column}
                items={opportunities.filter((opportunity) => (values[opportunity.id] ?? null) === column.value)}
                renderCard={(opportunity) => (
                  <FieldBoardCard
                    key={opportunity.id}
                    opportunity={opportunity}
                    fieldName={field.name}
                    pending={pendingIds.has(opportunity.id)}
                    moveTargets={columns.filter((target) => target.value !== column.value)}
                    onMove={(target) => void move(opportunity, target)}
                  />
                )}
              />
            ))}
          </div>
        </Board>
        <DragOverlay>
          {activeOpportunity ? (
            <div className="rotate-1 scale-105">
              <FieldBoardCardBody opportunity={activeOpportunity} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function FieldBoardColumn({
  column,
  items,
  renderCard,
}: {
  column: FieldColumn;
  items: FieldBoardOpportunity[];
  renderCard: (opportunity: FieldBoardOpportunity) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(column), data: { column } });

  return (
    <BoardColumn
      data-column-id={column.id}
      aria-label={`${column.label}, ${items.length} ${items.length === 1 ? "opportunity" : "opportunities"}`}
      title={
        <span className="flex items-center gap-2">
          {column.color && (
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: column.color }} />
          )}
          <span className={column.value === null ? "text-text-secondary" : undefined}>{column.label}</span>
        </span>
      }
      count={items.length}
      className="w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:overflow-hidden md:h-full"
      bodyRef={setNodeRef}
      bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`}
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<Lightbulb className="size-4" />}
          title="No opportunities"
          className={isOver ? "border-border-interactive" : undefined}
        />
      ) : (
        items.map(renderCard)
      )}
    </BoardColumn>
  );
}

function FieldBoardCard({
  opportunity,
  fieldName,
  pending,
  moveTargets,
  onMove,
}: {
  opportunity: FieldBoardOpportunity;
  fieldName: string;
  pending: boolean;
  moveTargets: FieldColumn[];
  onMove: (target: FieldColumn) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: opportunity.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
      className="group"
    >
      <FieldBoardCardBody
        opportunity={opportunity}
        pending={pending}
        dragHandle={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            type="button"
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label={`Drag to change ${fieldName}`}
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        actions={
          <CardMenu
            items={moveTargets.map((target) => ({
              label: target.value === null ? `Clear ${fieldName}` : `Move to ${target.label}`,
              onClick: () => onMove(target),
              disabled: pending,
            }))}
          />
        }
      />
    </div>
  );
}

function FieldBoardCardBody({
  opportunity,
  pending = false,
  dragHandle,
  actions,
}: {
  opportunity: FieldBoardOpportunity;
  pending?: boolean;
  dragHandle?: ReactNode;
  actions?: ReactNode;
}) {
  const { openPanel } = usePanelContext();

  return (
    <EntityCard
      interactive
      title={
        <button
          type="button"
          onClick={() => openPanel("opportunity", opportunity.id)}
          className="line-clamp-2 text-left hover:underline underline-offset-2"
        >
          {opportunity.title}
        </button>
      }
      description={opportunity.customerSegment}
      leading={
        (dragHandle || opportunity.squad) && (
          <div className="flex items-center gap-1.5">
            {dragHandle}
            {opportunity.squad && (
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: opportunity.squad.color }}
                title={opportunity.squad.name}
              />
            )}
          </div>
        )
      }
      actions={actions}
      className="w-full p-3 data-[pending]:opacity-60"
      data-pending={pending ? true : undefined}
    >
      <p className="text-xs text-text-subtle">
        {plural(opportunity._count.solutions, "solution")} · {opportunity._count.evidence} evidence
      </p>
    </EntityCard>
  );
}
