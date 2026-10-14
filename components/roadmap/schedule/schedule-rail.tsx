"use client";

import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Bug, GripVertical, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CardMenu } from "@/components/ui/card-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePanelContext } from "@/components/panels/panel-context";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { HORIZON_META, QUICK_ADD_HORIZONS } from "@/lib/roadmap";
import { solutionStatusBadge } from "@/lib/solution-status";
import { groupByOpportunity, matchesQuery, matchesRailFilter, type RailFilter } from "@/lib/roadmap/rail";
import type { Horizon, SquadData } from "@/lib/types";
import type { RoadmapCardData } from "../roadmap-card";
import { unscheduledDragId, type UnscheduledItem } from "../unscheduled-items-panel";

export type SolutionRailItem = Extract<UnscheduledItem, { kind: "solution" }>;
type FeedbackRailItem = Extract<UnscheduledItem, { kind: "feedback" }>;
export type BulkPlacement = "NOW" | "NEXT" | "LATER" | "AUTO";

const FILTERS: Array<{ value: RailFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "validated", label: "Validated" },
  { value: "top", label: "Scored 70+" },
];

type Props = {
  items: UnscheduledItem[];
  squads: ReadonlyArray<Pick<SquadData, "id" | "name" | "color">>;
  /** ACTIVE roadmap items that Building auto-sync created. */
  autoAdded: RoadmapCardData[];
  pendingItemKeys: ReadonlySet<string>;
  onScheduleOne: (item: SolutionRailItem) => void;
  onBulkSchedule: (items: SolutionRailItem[], placement: BulkPlacement) => void;
  onQuickAddFeedback: (item: FeedbackRailItem, horizon: Horizon) => void;
  onUndoAuto: (item: RoadmapCardData) => void;
  className?: string;
};

const NO_PENDING: ReadonlySet<string> = new Set();

function formatDay(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

/**
 * The "Ready to schedule" rail: validated and in-delivery solutions that have no
 * roadmap item yet, grouped under their opportunity. Cards drag onto the
 * timeline (ids are `unscheduled:solution:<id>`), have a keyboard-reachable
 * "Schedule" button, and can be multi-selected for a bulk placement. Bug
 * feedback with no roadmap item stays here too.
 */
export function ScheduleRail({
  items,
  squads,
  autoAdded,
  pendingItemKeys = NO_PENDING,
  onScheduleOne,
  onBulkSchedule,
  onQuickAddFeedback,
  onUndoAuto,
  className,
}: Props) {
  const labels = useLabels();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RailFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const squadsById = useMemo(() => new Map(squads.map((squad) => [squad.id, squad])), [squads]);

  const solutions = useMemo(() => items.filter((item): item is SolutionRailItem => item.kind === "solution"), [items]);
  const bugs = useMemo(() => items.filter((item): item is FeedbackRailItem => item.kind === "feedback"), [items]);
  const visibleSolutions = useMemo(
    () => solutions.filter((item) => matchesRailFilter(item, filter) && matchesQuery(query, item.title, item.opportunityTitle)),
    [solutions, filter, query],
  );
  const visibleBugs = useMemo(() => (filter === "all" ? bugs.filter((item) => matchesQuery(query, item.title)) : []), [bugs, filter, query]);
  const groups = useMemo(() => groupByOpportunity(visibleSolutions), [visibleSolutions]);
  // A card can leave the rail while selected (it was scheduled); only count what is still here.
  const selectedItems = solutions.filter((item) => selected.has(item.id));

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <aside
      aria-label="Ready to schedule"
      data-testid="schedule-rail"
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card", className)}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Ready to schedule</h2>
          <span data-testid="schedule-rail-count" className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {labels.solution.plural} from Discovery. Drag one onto the timeline, or press <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">/</kbd> to search. The roadmap item is created for you.
        </p>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${labels.solution.lowerPlural} & ${labels.opportunity.lowerPlural}`}
            aria-label="Filter the ready to schedule list"
            className="h-9 pl-7 md:h-8"
          />
        </div>
        <div role="group" aria-label="Filter by status or score" className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={filter === option.value ? "default" : "outline"}
              aria-pressed={filter === option.value}
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3" data-testid="schedule-rail-list">
        {autoAdded.length > 0 ? (
          <section aria-label="Auto-added" data-testid="schedule-rail-auto" className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-2">
            <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-primary">
              <RefreshCw aria-hidden="true" className="size-3" />
              Auto-added · {autoAdded.length}
            </h3>
            <ul className="flex flex-col gap-1">
              {autoAdded.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-xs" data-testid={`schedule-rail-auto-${item.id}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{item.title}</span>
                    <span className="block text-[11px] text-muted-foreground">Moved to In delivery, added {formatDay(item.startDate)}</span>
                  </span>
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label={`Undo auto-add of ${item.title}`} onClick={() => onUndoAuto(item)}>
                    Undo
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((group) => (
          <section key={group.opportunityId} aria-label={group.opportunityTitle} className="mb-3">
            <h3 className="mb-1.5 truncate text-xs font-semibold text-muted-foreground" title={group.opportunityTitle}>{group.opportunityTitle}</h3>
            <ul className="flex flex-col gap-1.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <SolutionCard
                    item={item}
                    squad={item.squadId ? squadsById.get(item.squadId) ?? null : null}
                    pending={pendingItemKeys.has(unscheduledDragId(item))}
                    selected={selected.has(item.id)}
                    onSelectedChange={(checked) => toggle(item.id, checked)}
                    onSchedule={() => onScheduleOne(item)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {visibleBugs.length > 0 ? (
          <section aria-label="Bugs" className="mb-3">
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Bugs</h3>
            <ul className="flex flex-col gap-1.5">
              {visibleBugs.map((item) => (
                <li key={item.id}>
                  <BugCard item={item} pending={pendingItemKeys.has(unscheduledDragId(item))} onQuickAdd={(horizon) => onQuickAddFeedback(item, horizon)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.length === 0 && visibleBugs.length === 0 ? (
          <p data-testid="schedule-rail-empty" className="py-6 text-center text-sm text-muted-foreground">
            {items.length > 0 ? "Nothing matches this filter." : `Everything from Discovery is on the roadmap.`}
          </p>
        ) : null}
      </div>

      {selectedItems.length > 0 ? (
        <div role="region" aria-label="Bulk schedule" data-testid="schedule-rail-bulk" className="flex shrink-0 flex-wrap items-center gap-1.5 border-t bg-muted/40 p-2">
          <b className="mr-1 text-xs">{selectedItems.length} selected</b>
          <span className="text-xs text-muted-foreground">Schedule as</span>
          {QUICK_ADD_HORIZONS.map((horizon) => (
            <Button
              key={horizon}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => { onBulkSchedule(selectedItems, horizon as BulkPlacement); setSelected(new Set()); }}
            >
              {HORIZON_META[horizon].label}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => { onBulkSchedule(selectedItems, "AUTO"); setSelected(new Set()); }}
          >
            Auto-fit
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function SolutionCard({ item, squad, pending, selected, onSelectedChange, onSchedule }: {
  item: SolutionRailItem;
  squad: Pick<SquadData, "id" | "name" | "color"> | null;
  pending: boolean;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
  onSchedule: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: unscheduledDragId(item),
    data: { unscheduledItem: item },
    disabled: pending,
  });
  const { openPanel } = usePanelContext();
  const status = solutionStatusBadge(item.status ?? "VALIDATED");
  return (
    <div
      ref={setNodeRef}
      data-testid={`unscheduled-item-solution:${item.id}`}
      aria-busy={pending || undefined}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 40 } : undefined}
      className={cn(
        "group flex items-start gap-1.5 rounded-lg border bg-surface-card p-2 transition-colors",
        selected && "border-primary/50 bg-primary/5",
        isDragging && "opacity-40",
      )}
    >
      <Checkbox checked={selected} onCheckedChange={(checked) => onSelectedChange(checked === true)} aria-label={`Select ${item.title}`} className="mt-1" disabled={pending} />
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        disabled={pending}
        aria-label="Drag to schedule"
        className="mt-0.5 inline-flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-wait disabled:opacity-50"
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => openPanel("solution", item.id)}
          disabled={pending}
          className="block w-full text-left text-sm font-medium leading-snug hover:underline underline-offset-2 disabled:cursor-wait"
        >
          {item.title}
        </button>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="secondary" className={cn("h-5 px-1.5 text-[10px]", status.className)}>{status.label}</Badge>
          {typeof item.score === "number" ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] tabular-nums" aria-label={`Score ${Math.round(item.score)}`}>{Math.round(item.score)}</Badge>
          ) : null}
          {squad ? (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
              <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: squad.color }} />
              {squad.name}
            </Badge>
          ) : null}
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        className="h-7 shrink-0 px-2 text-xs"
        aria-label={`Schedule ${item.title} at the suggested slot`}
        onClick={onSchedule}
      >
        {pending ? "Scheduling…" : "Schedule →"}
      </Button>
    </div>
  );
}

function BugCard({ item, pending, onQuickAdd }: { item: FeedbackRailItem; pending: boolean; onQuickAdd: (horizon: Horizon) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: unscheduledDragId(item),
    data: { unscheduledItem: item },
    disabled: pending,
  });
  const { openPanel } = usePanelContext();
  return (
    <div
      ref={setNodeRef}
      data-testid={`unscheduled-item-feedback:${item.id}`}
      aria-busy={pending || undefined}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 40 } : undefined}
      className={cn("group flex items-start gap-1.5 rounded-lg border bg-surface-card p-2", isDragging && "opacity-40")}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        disabled={pending}
        aria-label="Drag to schedule"
        className="mt-0.5 inline-flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-wait disabled:opacity-50"
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => openPanel("feedback", item.id)} disabled={pending} className="block w-full text-left text-sm font-medium leading-snug hover:underline underline-offset-2">
          {item.title}
        </button>
        <Badge variant="destructive" className="mt-1 h-5 gap-1 px-1.5 text-[10px]">
          <Bug aria-hidden="true" />
          Bug
        </Badge>
      </div>
      <CardMenu
        className="size-7 opacity-100"
        items={QUICK_ADD_HORIZONS.map((horizon) => ({ label: `Add to ${HORIZON_META[horizon].label}`, onClick: () => onQuickAdd(horizon) }))}
      />
    </div>
  );
}
