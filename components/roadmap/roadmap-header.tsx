"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, RefreshCw, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { WorkspaceHeader } from "@/components/patterns/workspace-page";
import { WorkspaceCreateButton, WorkspaceIconButton, WorkspaceMoreMenu } from "@/components/patterns/workspace-header-controls";
import { RoadmapViewToggle } from "./roadmap-view-toggle";
import { RoadmapGroupByToggle, type RoadmapGroupByFieldOption } from "./roadmap-group-by-toggle";
import { RoadmapFilters } from "./roadmap-filters";
import type { TimelineZoom } from "./native-timeline/timeline-model";
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
    <TooltipProvider>
    <Tooltip onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        aria-describedby={tooltipOpen ? `${summaryId} ${tooltipId}` : summaryId}
        render={<Button id={`${rail.controlsId}-toggle`} type="button" variant="outline" size="icon" data-testid="rail-toggle" className="relative size-11 md:size-8" aria-label={label} aria-expanded={rail.open} aria-controls={rail.controlsId} aria-keyshortcuts="[" onClick={rail.onToggle} />}
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
    </TooltipProvider>
  );
}

/**
 * Roadmap's header, on the shared workspace frame (docs/design/workspace-header.md).
 * Slot order: View (board / timeline) → timeline navigation and
 * ready-to-schedule rail toggle → Arrange (group-by, timeline only) → Filter →
 * auto-sync status → Primary (Schedule from discovery, timeline only) → ⋯ (card sort;
 * timeline scale and reload, timeline only).
 * The row below the title under `md` carries everything after the view toggle.
 */
export function RoadmapHeader({ squads, timeline, customFieldGroups = [], activeCustomFieldId = null, groupByValue, groupByOptions = [], cardSortHref }: {
  squads: SquadData[];
  timeline?: TimelineControls;
  /** Picklist fields on Roadmap Item that have options to filter by. */
  customFieldGroups?: CustomFieldFilterGroup[];
  /** The field the active filter resolved to on this page, if any. */
  activeCustomFieldId?: string | null;
  /** The timeline's resolved row-grouping mode ("phase" | "squad" | "none" | a CustomFieldDefinition id). Only rendered alongside `timeline`. */
  groupByValue?: string;
  /** Groupable (SELECT-type ROADMAP_ITEM) custom fields, for the grouping toggle. */
  groupByOptions?: RoadmapGroupByFieldOption[];
  /** Where the Card sort entry point goes (a round over Roadmap Items). Omitted = no link. */
  cardSortHref?: string;
}) {
  return (
    <WorkspaceHeader
      title="Roadmap"
      actions={<RoadmapViewToggle view={timeline ? "timeline" : "board"} />}
      controls={
        <>
          {timeline && (
            <div role="group" aria-label="Timeline navigation" className="mr-auto flex items-center gap-1 md:mr-0">
              <WorkspaceIconButton label="Previous period" onClick={() => timeline.onShift(-1)}><ChevronLeft /></WorkspaceIconButton>
              <WorkspaceIconButton label="Go to today" onClick={timeline.onToday}><CalendarDays /></WorkspaceIconButton>
              <WorkspaceIconButton label="Next period" onClick={() => timeline.onShift(1)}><ChevronRight /></WorkspaceIconButton>
            </div>
          )}
          {timeline?.schedule?.rail && <RailToggleButton rail={timeline.schedule.rail} />}
          {timeline && <RoadmapGroupByToggle value={groupByValue ?? "phase"} customFieldOptions={groupByOptions} />}
          <div className={timeline ? undefined : "ml-auto md:ml-0"}>
            <RoadmapFilters squads={squads} customFieldGroups={customFieldGroups} activeCustomFieldId={activeCustomFieldId} />
          </div>
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
          {timeline?.schedule && (
            <WorkspaceCreateButton
              label="Schedule from discovery"
              aria-haspopup="dialog"
              aria-keyshortcuts="/"
              onClick={timeline.schedule.onOpen}
            />
          )}
          <WorkspaceMoreMenu>
            {cardSortHref && (
              <DropdownMenuItem render={<Link href={cardSortHref} />}>
                <Shuffle /> Card sort
              </DropdownMenuItem>
            )}
            {cardSortHref && timeline && <DropdownMenuSeparator />}
            {timeline && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Timeline scale</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={timeline.zoom} onValueChange={(value) => timeline.onZoom(value as TimelineZoom)}>
                  <DropdownMenuRadioItem value="month">Month</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="quarter">Quarter</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )}
            {timeline && <DropdownMenuSeparator />}
            {timeline && (
              <DropdownMenuItem disabled={timeline.saving} onClick={() => window.location.reload()}>
                {timeline.saving ? "Reload timeline (wait for changes to save)" : "Reload timeline"}
              </DropdownMenuItem>
            )}
          </WorkspaceMoreMenu>
        </>
      }
    />
  );
}
