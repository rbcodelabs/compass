"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, RotateCw, Shuffle, SlidersHorizontal } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useUrlState } from "@/hooks/use-url-state";
import { RoadmapViewToggle } from "./roadmap-view-toggle";
import { RoadmapGroupByToggle, type RoadmapGroupByFieldOption } from "./roadmap-group-by-toggle";
import { WorkspaceSavedViewsMenu, type WorkspaceSavedViews } from "./workspace-saved-views";
import type { TimelineZoom } from "./native-timeline/timeline-model";
import { CUSTOM_FIELD_FILTER_PARAMS } from "@/lib/custom-field-filter-menu";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";
import type { SquadData } from "@/lib/types";

/** The collapsible "Ready to schedule" rail the header toggles. */
type RailToggle = {
  open: boolean;
  onToggle: () => void;
  /** Unscheduled items waiting in the rail: the same number the rail shows. */
  count: number;
  /** Items Building auto-sync added, so they are noticed while the rail is closed. */
  autoAdded: number;
  /** DOM id of the rail region this button controls. The button's own id is `${controlsId}-toggle`, so the page can return focus to it. */
  controlsId: string;
};

type TimelineControls = {
  zoom: TimelineZoom;
  onZoom: (zoom: TimelineZoom) => void;
  onShift: (direction: -1 | 1) => void;
  onToday: () => void;
  saving: boolean;
  /** Schedule-from-discovery entry point and the Building auto-sync indicator. */
  schedule?: { onOpen: () => void; autoSync: boolean; rail?: RailToggle };
};

function IconAction({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return (
    <Tooltip onOpenChange={setTooltipOpen}>
      {disabled ? (
        <TooltipTrigger aria-describedby={tooltipOpen ? tooltipId : undefined} render={<span className="inline-flex" tabIndex={0} aria-label="Saving changes; reload is unavailable" />}>
          <Button type="button" variant="outline" size="icon" className="size-11 md:size-9" aria-label={label} disabled>{children}</Button>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger aria-describedby={tooltipOpen ? tooltipId : undefined} render={<Button type="button" variant="outline" size="icon" className="size-11 md:size-9" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      )}
      <TooltipContent id={tooltipId} role="tooltip" side="bottom">{disabled ? "Wait for changes to save before reloading" : label}</TooltipContent>
    </Tooltip>
  );
}

function RailToggleButton({ rail }: { rail: RailToggle }) {
  const tooltipId = useId();
  const summaryId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const label = rail.open ? "Hide ready-to-schedule rail" : "Show ready-to-schedule rail";
  const summary = rail.count === 0
    ? "Nothing waiting to schedule"
    : `${rail.count} ready to schedule${rail.autoAdded > 0 ? `, ${rail.autoAdded} auto-added` : ""}`;
  const Icon = rail.open ? PanelLeftClose : PanelLeftOpen;
  return (
    <Tooltip onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        aria-describedby={tooltipOpen ? `${summaryId} ${tooltipId}` : summaryId}
        render={<Button id={`${rail.controlsId}-toggle`} type="button" variant="outline" size="icon" data-testid="rail-toggle" className="relative size-11 md:size-9" aria-label={label} aria-expanded={rail.open} aria-controls={rail.controlsId} aria-keyshortcuts="[" onClick={rail.onToggle} />}
      >
        <Icon aria-hidden="true" />
        {rail.count > 0 && (
          <span data-testid="rail-toggle-count" aria-hidden="true" className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums leading-none text-primary-foreground">
            {rail.count > 99 ? "99+" : rail.count}
          </span>
        )}
      </TooltipTrigger>
      <span id={summaryId} className="sr-only">{summary}</span>
      <TooltipContent id={tooltipId} role="tooltip" side="bottom">{label} <kbd className="ml-1 rounded border px-1 font-mono text-[10px]">[</kbd></TooltipContent>
    </Tooltip>
  );
}

export function RoadmapHeader({ squads, timeline, customFieldGroups = [], activeCustomFieldId = null, groupByValue, groupByOptions = [], cardSortHref, savedViews }: {
  squads: SquadData[];
  timeline?: TimelineControls;
  /** Picklist fields on Roadmap Item that have options to filter by. */
  customFieldGroups?: CustomFieldFilterGroup[];
  /** The field the active filter resolved to on this page, if any. */
  activeCustomFieldId?: string | null;
  /** The resolved grouping mode ("phase" | "squad" | "none" | a CustomFieldDefinition id): timeline rows, or board swimlanes. The picker shows on the timeline, and on the board when this is passed. */
  groupByValue?: string;
  /** Groupable (SELECT-type ROADMAP_ITEM) custom fields, for the grouping toggle. */
  groupByOptions?: RoadmapGroupByFieldOption[];
  /** Where the Card sort entry point goes (a round over Roadmap Items). Omitted = no link. */
  cardSortHref?: string;
  /** Saved roadmap views for this workspace. Omitted = no picker (e.g. in isolated tests). */
  savedViews?: WorkspaceSavedViews;
}) {
  const { params, set } = useUrlState();
  const squad = params.get("squad");
  const activeFieldValue = params.get("fieldValue");
  // One tag filter at a time: selecting a value in a second field replaces the
  // first, and "All" clears both halves of the pair together.
  const setCustomField = (fieldId: string, value: string | null) =>
    set({ field: value ? fieldId : null, fieldValue: value });
  const anyFilter = Boolean(squad) || Boolean(activeCustomFieldId && activeFieldValue);
  const optionsTooltipId = useId();
  const [optionsTooltipOpen, setOptionsTooltipOpen] = useState(false);
  return (
    <TooltipProvider>
      <header data-slot="workspace-header" className="sticky top-0 z-20 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-border-default bg-surface-app px-3 py-3 md:static md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-3 md:px-6">
        <h1 className="col-start-1 row-start-1 truncate text-lg font-semibold tracking-tight text-text-primary">Roadmap</h1>
        <div className="col-start-2 row-start-1 md:col-start-3"><RoadmapViewToggle view={timeline ? "timeline" : "board"} /></div>
        <div aria-label="Roadmap controls" className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2 md:col-span-1 md:flex-nowrap md:col-start-2 md:row-start-1">
          {timeline && <div role="group" aria-label="Timeline navigation" className="mr-auto flex items-center gap-1 md:mr-0">
            <IconAction label="Previous period" onClick={() => timeline.onShift(-1)}><ChevronLeft /></IconAction>
            <IconAction label="Go to today" onClick={timeline.onToday}><CalendarDays /></IconAction>
            <IconAction label="Next period" onClick={() => timeline.onShift(1)}><ChevronRight /></IconAction>
          </div>}
          {(timeline || groupByValue !== undefined) && (
            <RoadmapGroupByToggle variant={timeline ? "timeline" : "board"} value={groupByValue ?? "phase"} customFieldOptions={groupByOptions} />
          )}
          {timeline?.schedule?.rail && <RailToggleButton rail={timeline.schedule.rail} />}
          {timeline?.schedule && (
            <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-0" aria-label="Schedule from discovery" aria-haspopup="dialog" aria-keyshortcuts="/" onClick={timeline.schedule.onOpen}>
              <Plus className="size-4" aria-hidden="true" />
              <span className="md:hidden" aria-hidden="true">Schedule</span>
              <span className="hidden md:inline" aria-hidden="true">Schedule from discovery…</span>
              <kbd aria-hidden="true" className="ml-1 hidden rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground md:inline">/</kbd>
            </Button>
          )}
          {timeline?.schedule?.autoSync && (
            <span
              data-testid="auto-sync-indicator"
              title="Work that reaches In delivery is added to the roadmap automatically"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-1 text-xs font-medium text-primary"
            >
              <RefreshCw className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Auto-sync on</span>
              <span className="sr-only sm:hidden">Auto-sync on</span>
              {(timeline.schedule.rail?.autoAdded ?? 0) > 0 && <span data-testid="auto-added-count" className="tabular-nums">· {timeline.schedule.rail!.autoAdded} added</span>}
            </span>
          )}
          {cardSortHref && (
            <Link
              href={cardSortHref}
              className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11 md:min-h-0" })}
            >
              <Shuffle className="size-4" /> Card sort
            </Link>
          )}
          <DropdownMenu>
            <Tooltip onOpenChange={setOptionsTooltipOpen}>
              <TooltipTrigger aria-describedby={optionsTooltipOpen ? optionsTooltipId : undefined} render={<DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="View options" className="relative ml-auto size-11 md:ml-0 md:size-9" />} />}>
                <SlidersHorizontal />
                {anyFilter && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
              </TooltipTrigger>
              <TooltipContent id={optionsTooltipId} role="tooltip" side="bottom">View options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" aria-label="View options" className="w-56 max-w-[calc(100vw-24px)] [&_[role=menuitemradio]]:min-h-11 md:[&_[role=menuitemradio]]:min-h-0">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Squad</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={squad ?? "__all__"} onValueChange={(value) => set({ squad: value === "__all__" ? null : value })}>
                  <DropdownMenuRadioItem value="__all__">All squads</DropdownMenuRadioItem>
                  {squads.map((option) => <DropdownMenuRadioItem key={option.id} value={option.id}><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />{option.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              {customFieldGroups.map((group) => (
                <DropdownMenuGroup key={group.fieldId}>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={group.fieldId === activeCustomFieldId ? (activeFieldValue ?? "__all__") : "__all__"}
                    onValueChange={(value) => setCustomField(group.fieldId, value === "__all__" ? null : value)}
                  >
                    <DropdownMenuRadioItem value="__all__">All</DropdownMenuRadioItem>
                    {group.options.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />}
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              ))}
              {timeline && <DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Timeline scale</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={timeline.zoom} onValueChange={(value) => timeline.onZoom(value as TimelineZoom)}>
                  <DropdownMenuRadioItem value="month">Month</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="quarter">Quarter</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>}
              {anyFilter && <><DropdownMenuSeparator /><DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => set({ squad: null, ...Object.fromEntries(CUSTOM_FIELD_FILTER_PARAMS.map((name) => [name, null])) })}>Clear filters</DropdownMenuItem></>}
            </DropdownMenuContent>
          </DropdownMenu>
          {timeline && <IconAction label="Reload timeline" disabled={timeline.saving} onClick={() => window.location.reload()}><RotateCw /></IconAction>}
        </div>
        {/* Own row: the title column is only as wide as the title at 1280px in Timeline mode, and the controls column is auto-sized, so neither can absorb this button. */}
        {savedViews && <div className="col-span-2 col-start-1 row-start-3 min-w-0 md:col-span-3"><WorkspaceSavedViewsMenu savedViews={savedViews} /></div>}
      </header>
    </TooltipProvider>
  );
}
