"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarClock, Layers, Target } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { solutionStatusBadge } from "@/lib/solution-status";
import { searchCatalog, solutionsToSchedule, type CatalogSolution, type PaletteRow, type ScheduleCatalog } from "@/lib/roadmap/rail";
import type { CalendarDate, SlotRange } from "@/lib/roadmap/scheduling";

const LENGTH_OPTIONS = [2, 4, 6, 8, 12] as const;

export type PaletteDates = { startDate: CalendarDate; weeks: number };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: Pick<ScheduleCatalog, "solutions" | "opportunities">;
  scheduledIds: ReadonlySet<string>;
  /** First free slot for a solution's squad at or after today, shown as the default in the dates step. */
  suggestSlot: (solution: CatalogSolution) => SlotRange;
  /** Resolves once the create finished (or failed); the palette closes either way. */
  onSchedule: (solutions: CatalogSolution[], dates: PaletteDates | null) => Promise<void> | void;
};

function rowId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

/**
 * Command palette for scheduling from Discovery. Opens from the header button
 * or the `/` shortcut. Enter schedules the highlighted solution at the suggested
 * slot; Tab reveals a start / length step; Shift+Enter schedules every
 * unscheduled solution under the highlighted one's opportunity; Esc closes.
 * Already-scheduled rows are listed but inert.
 */
export function SchedulePalette({ open, onOpenChange, catalog, scheduledIds, suggestSlot, onSchedule }: Props) {
  // Remount the body per open so query, highlight and the dates step always start fresh.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <PaletteBody catalog={catalog} scheduledIds={scheduledIds} suggestSlot={suggestSlot} onSchedule={onSchedule} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function PaletteBody({ catalog, scheduledIds, suggestSlot, onSchedule, onClose }: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const labels = useLabels();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [datesOpen, setDatesOpen] = useState(false);
  // The start the user typed for one specific solution; otherwise the suggested slot is used.
  const [startOverride, setStartOverride] = useState<{ solutionId: string; value: CalendarDate } | null>(null);
  const [weeks, setWeeks] = useState(6);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => searchCatalog(catalog, scheduledIds, query), [catalog, scheduledIds, query]);
  const active = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);
  const activeRow: PaletteRow | undefined = active >= 0 ? rows[active] : undefined;

  useEffect(() => {
    document.getElementById(rowId(listId, active))?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  // The dates step defaults to the suggested slot for whichever solution is highlighted.
  const activeSolution = activeRow?.type === "solution" ? activeRow.solution : null;
  const suggestedStart = activeSolution && datesOpen ? suggestSlot(activeSolution).start : "";
  const startDate = startOverride && activeSolution && startOverride.solutionId === activeSolution.id ? startOverride.value : suggestedStart;

  async function commit(all: boolean, row: PaletteRow | undefined = activeRow) {
    if (!row || busy) return;
    const targets = solutionsToSchedule(row, catalog, scheduledIds, all);
    if (targets.length === 0) return;
    const dates = datesOpen && targets.length === 1 && startDate ? { startDate, weeks } : null;
    setBusy(true);
    try {
      await onSchedule(targets, dates);
    } finally {
      setBusy(false);
      onClose();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      setIndex((current) => {
        const from = Math.min(current, rows.length - 1);
        return (from + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      void commit(event.shiftKey);
    } else if (event.key === "Tab" && !event.shiftKey && activeSolution && !scheduledIds.has(activeSolution.id)) {
      // Tab is a deliberate shortcut here: it reveals the dates step and moves into it.
      event.preventDefault();
      setDatesOpen(true);
      requestAnimationFrame(() => document.getElementById(`${listId}-start`)?.focus());
    }
  }

  const solutionRows = rows.filter((row) => row.type === "solution");
  const opportunityRows = rows.filter((row) => row.type === "opportunity");

  return (
    <DialogContent
      showCloseButton={false}
      initialFocus={inputRef}
      data-testid="schedule-palette"
      className="top-[18%] gap-0 overflow-hidden p-0 sm:max-w-xl translate-y-0"
    >
      <DialogTitle className="sr-only">Schedule from discovery</DialogTitle>
      <DialogDescription className="sr-only">
        Search {labels.solution.lowerPlural} and {labels.opportunity.lowerPlural}. Press Enter to schedule the highlighted one at the suggested slot.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b px-3">
        <span aria-hidden="true" className="text-muted-foreground">/</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? rowId(listId, active) : undefined}
          aria-autocomplete="list"
          aria-label={`Search ${labels.opportunity.lowerPlural} and ${labels.solution.lowerPlural}`}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={onKeyDown}
          placeholder={`Search ${labels.opportunity.lowerPlural} and ${labels.solution.lowerPlural}…`}
          autoComplete="off"
          className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto overscroll-contain py-1">
        {rows.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No matches in Discovery.</p> : null}
        {solutionRows.length > 0 ? <GroupHeading>{labels.solution.plural}</GroupHeading> : null}
        {rows.map((row, position) => row.type === "solution" ? (
          <PaletteOption key={`s-${row.solution.id}`} id={rowId(listId, position)} active={position === active} disabled={row.scheduled} onHover={() => setIndex(position)} onChoose={() => { setIndex(position); void commit(false, row); }}>
            <Layers aria-hidden="true" className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{row.solution.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{row.solution.opportunityTitle}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {row.scheduled ? "scheduled" : `${solutionStatusBadge(row.solution.status).label}${row.solution.score !== null ? ` · ${Math.round(row.solution.score)}` : ""}`}
            </span>
          </PaletteOption>
        ) : null)}
        {opportunityRows.length > 0 ? <GroupHeading>{labels.opportunity.plural}</GroupHeading> : null}
        {rows.map((row, position) => row.type === "opportunity" ? (
          <PaletteOption key={`o-${row.opportunity.id}`} id={rowId(listId, position)} active={position === active} disabled={row.unscheduled.length === 0} onHover={() => setIndex(position)} onChoose={() => { setIndex(position); void commit(true, row); }}>
            <Target aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{row.opportunity.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.unscheduled.length} unscheduled {row.unscheduled.length === 1 ? labels.solution.lower : labels.solution.lowerPlural} · Shift+Enter schedules all
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{row.unscheduled.length === 0 ? "all scheduled" : labels.opportunity.singular}</span>
          </PaletteOption>
        ) : null)}
      </div>
      {datesOpen && activeSolution ? (
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-2 text-xs" data-testid="schedule-palette-dates">
          <CalendarClock aria-hidden="true" className="size-4 text-muted-foreground" />
          <label className="flex items-center gap-1.5">
            Start
            <input id={`${listId}-start`} type="date" value={startDate} onChange={(event) => activeSolution && setStartOverride({ solutionId: activeSolution.id, value: event.target.value })} className="h-8 rounded-md border bg-card px-2 text-foreground" />
          </label>
          <label className="flex items-center gap-1.5">
            Length
            <select value={weeks} onChange={(event) => setWeeks(Number(event.target.value))} className="h-8 rounded-md border bg-card px-2 text-foreground">
              {LENGTH_OPTIONS.map((option) => <option key={option} value={option}>{option} wks</option>)}
            </select>
          </label>
          <span className="text-muted-foreground">Press Enter to schedule.</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <span><Kbd>↵</Kbd> schedule at suggested slot</span>
        <span><Kbd>⇥</Kbd> choose dates</span>
        <span><Kbd>⇧↵</Kbd> schedule all under {labels.opportunity.lower}</span>
        <span><Kbd>esc</Kbd> close</span>
      </div>
    </DialogContent>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <div role="presentation" className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-foreground">{children}</kbd>;
}

function PaletteOption({ id, active, disabled, onHover, onChoose, children }: {
  id: string;
  active: boolean;
  disabled: boolean;
  onHover: () => void;
  onChoose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-state={disabled ? "scheduled" : undefined}
      onMouseMove={onHover}
      onClick={disabled ? undefined : onChoose}
      className={cn(
        "mx-1 flex items-center gap-3 rounded-md px-3 py-2 text-sm",
        active && "bg-muted",
        disabled ? "cursor-default opacity-60" : "cursor-pointer",
      )}
    >
      {children}
    </div>
  );
}
