"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Gantt } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import { updateRoadmapItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "./roadmap-card";
import type { Horizon } from "@/lib/types";

// The Gantt library reads Date components with local-timezone getters
// (getFullYear/getMonth/getDate) for its grid columns, chart axis, and bar
// positioning. Our stored dates are UTC-midnight ISO strings (from a plain
// <input type="date">), so handing the library `new Date(isoString)`
// directly would display one day early in any negative-UTC-offset timezone.
// Instead, pull the Y-M-D straight out of the ISO string (always UTC, so
// this is unambiguous) and build a local Date whose local getters already
// return the intended calendar day.
function parseCalendarDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Inverse of parseCalendarDate: the library reports drag/resize results as
// local-midnight Dates (same convention it reads). Convert back to a
// UTC-midnight Date before persisting, so storage stays consistent with the
// add form and edit dialog (which both store UTC-midnight for a given
// calendar day) regardless of the viewer's UTC offset.
function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

const HORIZON_COLORS: Record<Horizon, string> = {
  NOW: "#10b981", // emerald-500
  NEXT: "#3b82f6", // blue-500
  LATER: "#94a3b8", // slate-400
  SHIPPED: "#a855f7", // purple-500
};

// Extra fields beyond the library's own ITask shape are carried via its
// `[key: string]: any` index signature — avoid the `data` key, which the
// library reserves for nested/child tasks.
type GanttTask = {
  id: string;
  text: string;
  start: Date;
  end: Date;
  type: "task";
  horizon: Horizon;
};

type TaskTemplateProps = {
  data: GanttTask;
};

function TaskBar({ data }: TaskTemplateProps) {
  const color = HORIZON_COLORS[data.horizon] ?? HORIZON_COLORS.NOW;
  return (
    <div
      style={{
        backgroundColor: color,
        color: "#fff",
        height: "100%",
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        borderRadius: "4px",
        fontSize: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {data.text}
    </div>
  );
}

type Props = {
  items: RoadmapCardData[];
  revalidatePathStr: string;
};

export function RoadmapGanttChart({ items, revalidatePathStr }: Props) {
  const router = useRouter();

  const datedItems = useMemo(
    () => items.filter((item) => item.startDate && item.endDate),
    [items]
  );
  const undatedCount = items.length - datedItems.length;

  const tasks: GanttTask[] = useMemo(
    () =>
      datedItems.map((item) => ({
        id: item.id,
        text: item.title,
        start: parseCalendarDate(item.startDate as string),
        end: parseCalendarDate(item.endDate as string),
        type: "task" as const,
        horizon: item.horizon,
      })),
    [datedItems]
  );

  async function handleUpdateTask(ev: { id: string; task: { start?: Date; end?: Date } }) {
    if (!ev.task.start || !ev.task.end) return;
    await updateRoadmapItem(
      ev.id,
      { startDate: toUtcMidnight(ev.task.start), endDate: toUtcMidnight(ev.task.end) },
      revalidatePathStr
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {undatedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {`${undatedCount} item${undatedCount === 1 ? "" : "s"} ${undatedCount === 1 ? "has" : "have"} no dates yet and aren't shown on the timeline.`}
        </p>
      )}

      {tasks.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-300/70 py-16 text-sm text-slate-400">
          No items have dates yet. Add a start and end date to see them here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl ring-1 ring-border">
          {/*
            The library lays its grid columns + chart out as flex children
            and lets the chart pane shrink — at narrow viewports (e.g.
            mobile) the grid columns alone can exceed the available width,
            squeezing the chart pane to 0 instead of overflowing. Forcing a
            min-width on this inner wrapper makes the *whole* component
            (grid + chart) overflow together, so the outer overflow-x-auto
            above actually gets a horizontal scrollbar instead of a
            silently-collapsed chart.
          */}
          <div style={{ minWidth: 720 }}>
            <Gantt
              tasks={tasks}
              // @ts-expect-error taskTemplate typing from the library expects its own ITask shape
              taskTemplate={(props) => <TaskBar {...props} />}
              onUpdateTask={handleUpdateTask}
            />
          </div>
        </div>
      )}
    </div>
  );
}
