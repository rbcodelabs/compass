"use client";

import dynamic from "next/dynamic";
import type { RoadmapCardData } from "./roadmap-card";
import type { UnscheduledItem } from "./unscheduled-items-panel";

// The Gantt library touches window/document at module scope, so it must be
// excluded from SSR. `ssr: false` is only valid inside a Client Component,
// which is why this thin wrapper (rather than page.tsx itself) owns the
// dynamic import.
const RoadmapGanttChart = dynamic(
  () => import("./roadmap-gantt-chart").then((mod) => mod.RoadmapGanttChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center rounded-xl border border-dashed border-border-strong/70 py-16 text-sm text-text-subtle">
        Loading timeline…
      </div>
    ),
  }
);

type Props = {
  items: RoadmapCardData[];
  workspaceId: string;
  unscheduledItems?: UnscheduledItem[];
  revalidatePathStr: string;
};

export function RoadmapGantt({ items, workspaceId, unscheduledItems, revalidatePathStr }: Props) {
  return (
    <RoadmapGanttChart
      items={items}
      workspaceId={workspaceId}
      unscheduledItems={unscheduledItems}
      revalidatePathStr={revalidatePathStr}
    />
  );
}
