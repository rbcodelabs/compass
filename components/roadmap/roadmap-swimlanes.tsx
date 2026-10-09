"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight } from "lucide-react";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import { AddItemForm } from "./add-item-form";
import { HORIZON_META, isLaunchHorizon } from "@/lib/roadmap";
import { cellDroppableId, laneKeyForCard, type Lane, type SwimlaneSpec } from "@/lib/roadmap/swimlanes";
import type { Horizon } from "@/lib/types";
import { cn } from "@/lib/utils";

const HORIZON_ACCENT = {
  NOW: "bg-status-success",
  NEXT: "bg-status-info",
  LATER: "bg-status-neutral",
  LAUNCHING: "bg-status-warning",
  LAUNCHED: "bg-status-success",
  SHIPPED: "bg-status-success",
} as const;

const COLUMN_MIN_PX = 272;
const COLUMN_GAP_PX = 12;

type AvailableKR = { id: string; title: string; objectiveTitle: string };
type AvailableSolution = { id: string; title: string; opportunityTitle: string };
type AvailableOpportunity = { id: string; title: string };
type AvailableExperiment = { id: string; title: string; status: string };

type Props = {
  spec: SwimlaneSpec;
  lanes: Lane[];
  horizons: Horizon[];
  columns: Record<Horizon, RoadmapCardData[]>;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  launchWorkflowEnabled: boolean;
  limits: Partial<Record<Horizon, number | null | undefined>>;
  onItemAdded: (item: RoadmapCardData, lane: Lane) => void;
  onArchive: (itemId: string) => void;
  availableKRs?: AvailableKR[];
  availableSolutions?: AvailableSolution[];
  availableOpportunities?: AvailableOpportunity[];
  availableExperiments?: AvailableExperiment[];
};

/**
 * The roadmap Board's swimlane layout: one row per lane (squad or custom-field
 * option, then Unassigned), one cell per horizon. A sticky header row carries the
 * horizon names and totals so they stay visible while the lanes scroll under it.
 */
export function RoadmapSwimlanes({
  spec,
  lanes,
  horizons,
  columns,
  workspaceId,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  launchWorkflowEnabled,
  limits,
  onItemAdded,
  onArchive,
  availableKRs,
  availableSolutions,
  availableOpportunities,
  availableExperiments,
}: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const gridTemplateColumns = `repeat(${horizons.length}, minmax(${COLUMN_MIN_PX}px, 1fr))`;
  const minWidth = horizons.length * COLUMN_MIN_PX + (horizons.length - 1) * COLUMN_GAP_PX;

  const cardsByLane = new Map<string, Record<Horizon, RoadmapCardData[]>>();
  for (const lane of lanes) {
    cardsByLane.set(lane.key, Object.fromEntries(horizons.map((h) => [h, [] as RoadmapCardData[]])) as Record<Horizon, RoadmapCardData[]>);
  }
  for (const horizon of horizons) {
    for (const card of columns[horizon]) {
      cardsByLane.get(laneKeyForCard(spec, card))?.[horizon].push(card);
    }
  }

  function toggle(laneKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(laneKey)) next.delete(laneKey);
      else next.add(laneKey);
      return next;
    });
  }

  return (
    // `contain: inline-size` + `flex-1 basis-0` keep the 1fr columns from sizing to the
    // widest card text inside the board's `w-max` track (which made them thousands of px wide).
    <div
      data-slot="roadmap-swimlanes"
      className="flex flex-1 basis-0 flex-col gap-3 pb-3 [contain:inline-size]"
      style={{ minWidth }}
    >
      <div
        role="row"
        className="sticky top-0 z-20 grid gap-3 border-b border-border-default bg-surface-page pt-3 pb-2"
        style={{ gridTemplateColumns }}
      >
        {horizons.map((horizon) => {
          const count = columns[horizon].length;
          const limit = limits[horizon];
          const overLimit = typeof limit === "number" && count > limit;
          return (
            <div key={horizon} role="columnheader" className="flex items-center gap-2 px-1">
              <span aria-hidden className={cn("h-4 w-1 rounded-full", HORIZON_ACCENT[horizon])} />
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{HORIZON_META[horizon].label}</h3>
              <span
                aria-label={typeof limit === "number" ? `${count} of ${limit} items` : `${count} items`}
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  overLimit ? "bg-status-warning-surface text-status-warning" : "bg-surface-panel text-text-subtle",
                )}
              >
                {typeof limit === "number" ? `${count}/${limit}` : count}
              </span>
            </div>
          );
        })}
      </div>

      {lanes.map((lane) => {
        const laneCards = cardsByLane.get(lane.key)!;
        const total = horizons.reduce((sum, h) => sum + laneCards[h].length, 0);
        const isCollapsed = collapsed.has(lane.key);
        const bodyId = `roadmap-lane-${lane.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        return (
          <section key={lane.key} data-testid="roadmap-lane" data-lane={lane.key} aria-label={`${lane.label} lane`} className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              onClick={() => toggle(lane.key)}
              className="sticky left-0 z-10 flex w-fit items-center gap-2 rounded-lg border border-border-default bg-surface-inset px-2.5 py-1.5 text-left text-sm font-semibold text-text-primary hover:bg-surface-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isCollapsed ? <ChevronRight aria-hidden className="size-4 text-text-subtle" /> : <ChevronDown aria-hidden className="size-4 text-text-subtle" />}
              {lane.color && <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: lane.color }} />}
              <span className="max-w-[16rem] truncate">{lane.label}</span>
              <span aria-label={`${total} items`} className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs font-normal text-text-subtle">
                {total}
              </span>
            </button>
            {!isCollapsed && (
              <div id={bodyId} className="grid gap-3" style={{ gridTemplateColumns }}>
                {horizons.map((horizon) => (
                  <LaneCell
                    key={horizon}
                    lane={lane}
                    horizon={horizon}
                    items={laneCards[horizon]}
                    workspaceId={workspaceId}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    revalidatePathStr={revalidatePathStr}
                    launchWorkflowEnabled={launchWorkflowEnabled}
                    onItemAdded={onItemAdded}
                    onArchive={onArchive}
                    availableKRs={availableKRs}
                    availableSolutions={availableSolutions}
                    availableOpportunities={availableOpportunities}
                    availableExperiments={availableExperiments}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LaneCell({
  lane,
  horizon,
  items,
  workspaceId,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  launchWorkflowEnabled,
  onItemAdded,
  onArchive,
  availableKRs,
  availableSolutions,
  availableOpportunities,
  availableExperiments,
}: {
  lane: Lane;
  horizon: Horizon;
  items: RoadmapCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  launchWorkflowEnabled: boolean;
  onItemAdded: (item: RoadmapCardData, lane: Lane) => void;
  onArchive: (itemId: string) => void;
  availableKRs?: AvailableKR[];
  availableSolutions?: AvailableSolution[];
  availableOpportunities?: AvailableOpportunity[];
  availableExperiments?: AvailableExperiment[];
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellDroppableId(lane.key, horizon),
    data: { horizon, laneKey: lane.key },
  });
  // A launch horizon can't take a freshly typed item — see RoadmapColumn.
  const allowAdd = !isLaunchHorizon(horizon);

  return (
    <div
      ref={setNodeRef}
      data-testid="roadmap-lane-cell"
      data-lane={lane.key}
      data-horizon={horizon}
      className={cn(
        "flex min-h-24 flex-col gap-3 rounded-xl border border-dashed border-border-default bg-surface-inset/60 p-2",
        isOver && "border-solid bg-primary/5 ring-2 ring-inset ring-ring/25",
      )}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <RoadmapCard
            key={item.id}
            item={item}
            workspaceId={workspaceId}
            revalidatePathStr={revalidatePathStr}
            onArchive={onArchive}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            launchWorkflowEnabled={launchWorkflowEnabled}
          />
        ))}
      </SortableContext>
      {allowAdd && (
        <AddItemForm
          workspaceId={workspaceId}
          horizon={horizon}
          revalidatePathStr={revalidatePathStr}
          onAdd={(item) => onItemAdded(item, lane)}
          availableKRs={availableKRs}
          availableSolutions={availableSolutions}
          availableOpportunities={availableOpportunities}
          availableExperiments={availableExperiments}
        />
      )}
    </div>
  );
}
