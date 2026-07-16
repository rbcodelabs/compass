"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  useDroppable,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Gantt, type IScaleConfig } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import {
  updateRoadmapItem,
  promoteToRoadmap,
  promoteFeedbackToRoadmap,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "./roadmap-card";
import {
  UnscheduledItemsPanel,
  parseUnscheduledDragId,
  type UnscheduledItem,
} from "./unscheduled-items-panel";
import { ScheduleItemDialog } from "./schedule-item-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

// Items without real dates still get a bar (dashed, see TaskBar below) so
// they're visible and draggable on the Timeline instead of disappearing.
// This placeholder span is never persisted on its own — only a drag/resize
// through handleUpdateTask writes real dates. today() -> +14 days matches
// ScheduleItemDialog's default for the same reason: a friendly, familiar
// starting point.
const PLACEHOLDER_SPAN_DAYS = 14;

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

const HORIZON_COLORS: Record<Horizon, string> = {
  NOW: "#10b981", // emerald-500
  NEXT: "#3b82f6", // blue-500
  LATER: "#94a3b8", // slate-400
  SHIPPED: "#a855f7", // purple-500
};

// Named zoom levels, each swapping the Gantt's header scale + column width.
// The library also ships a continuous wheel-zoom mode (the `zoom` prop), but
// discrete labeled levels are more discoverable and match how the rest of
// the app's view controls work (see RoadmapViewToggle's Board/Timeline
// tabs). Every format is a function rather than the library's `%`-token
// strings so the exact output is under our control and easy to verify.
const ZOOM_LEVEL_ORDER = ["day", "week", "month", "quarter", "year"] as const;
type ZoomLevel = (typeof ZOOM_LEVEL_ORDER)[number];

const monthYearLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

const ZOOM_LEVELS: Record<ZoomLevel, { label: string; cellWidth: number; scales: IScaleConfig[] }> = {
  day: {
    label: "Day",
    cellWidth: 100, // matches the Gantt library's own default, so this level looks unchanged from before zoom levels existed
    scales: [
      { unit: "month", step: 1, format: monthYearLabel },
      { unit: "day", step: 1, format: (d) => String(d.getDate()) },
    ],
  },
  week: {
    label: "Week",
    cellWidth: 70,
    scales: [
      { unit: "month", step: 1, format: monthYearLabel },
      { unit: "week", step: 1, format: (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
    ],
  },
  month: {
    label: "Month",
    cellWidth: 90,
    scales: [
      { unit: "year", step: 1, format: (d) => String(d.getFullYear()) },
      { unit: "month", step: 1, format: (d) => d.toLocaleDateString("en-US", { month: "short" }) },
    ],
  },
  quarter: {
    label: "Quarter",
    cellWidth: 100,
    scales: [
      { unit: "year", step: 1, format: (d) => String(d.getFullYear()) },
      { unit: "quarter", step: 1, format: (d) => `Q${Math.floor(d.getMonth() / 3) + 1}` },
    ],
  },
  year: {
    label: "Year",
    cellWidth: 70,
    scales: [{ unit: "year", step: 1, format: (d) => String(d.getFullYear()) }],
  },
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
  hasDates: boolean;
};

type TaskTemplateProps = {
  data: GanttTask;
};

const BAR_BASE_STYLE: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  borderRadius: "4px",
  fontSize: "12px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function TaskBar({ data }: TaskTemplateProps) {
  const color = HORIZON_COLORS[data.horizon] ?? HORIZON_COLORS.NOW;

  if (!data.hasDates) {
    return (
      <div
        title="No dates set yet — drag or resize this bar to schedule it"
        style={{
          ...BAR_BASE_STYLE,
          backgroundColor: "transparent",
          border: `1.5px dashed ${color}`,
          color,
        }}
      >
        {data.text}
        <span className="ml-1 shrink-0 opacity-70">(unscheduled)</span>
      </div>
    );
  }

  return (
    <div style={{ ...BAR_BASE_STYLE, backgroundColor: color, color: "#fff" }}>{data.text}</div>
  );
}

// Single drop zone covering the whole chart area — the Gantt library has no
// API for translating a drop's pixel position into a date, so dropping an
// unscheduled item anywhere in this zone opens ScheduleItemDialog rather
// than inferring dates from where the cursor landed.
const GANTT_DROP_ZONE_ID = "gantt-drop-zone";

type Props = {
  items: RoadmapCardData[];
  workspaceId: string;
  unscheduledItems?: UnscheduledItem[];
  revalidatePathStr: string;
};

export function RoadmapGanttChart({ items, workspaceId, unscheduledItems, revalidatePathStr }: Props) {
  const router = useRouter();
  const [unscheduled, setUnscheduled] = useState<UnscheduledItem[]>(unscheduledItems ?? []);
  const [scheduleTarget, setScheduleTarget] = useState<UnscheduledItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>("day");
  const zoom = ZOOM_LEVELS[zoomLevel];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  // Stable per-mount so every undated item's placeholder bar lines up in the
  // same spot rather than drifting a pixel apart across re-renders.
  const [placeholderStart] = useState(startOfToday);
  const placeholderEnd = useMemo(() => addDays(placeholderStart, PLACEHOLDER_SPAN_DAYS), [placeholderStart]);

  const undatedCount = useMemo(
    () => items.filter((item) => !item.startDate || !item.endDate).length,
    [items]
  );

  const tasks: GanttTask[] = useMemo(
    () =>
      items.map((item) => {
        const hasDates = Boolean(item.startDate && item.endDate);
        return {
          id: item.id,
          text: item.title,
          start: hasDates ? parseCalendarDate(item.startDate as string) : placeholderStart,
          end: hasDates ? parseCalendarDate(item.endDate as string) : placeholderEnd,
          type: "task" as const,
          horizon: item.horizon,
          hasDates,
        };
      }),
    [items, placeholderStart, placeholderEnd]
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

  // Quick-add fallback (from the unscheduled panel's card menu, not a drag):
  // creates the item with no dates, same as the Board's quick-add. It shows
  // up immediately here too, as a dashed placeholder bar — drag/resize it
  // (or use Edit on the Board) to set real dates.
  function handleQuickAdd(item: UnscheduledItem, horizon: Horizon) {
    setUnscheduled((prev) => prev.filter((i) => i !== item));
    const promoted =
      item.kind === "solution"
        ? promoteToRoadmap(item.id, workspaceId, horizon, item.squadId, item.opportunityId)
        : promoteFeedbackToRoadmap(item.id, workspaceId, horizon, revalidatePathStr);
    promoted.then(() => router.refresh());
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const parsed = parseUnscheduledDragId(active.id as string);
    if (!parsed || !over || over.id !== GANTT_DROP_ZONE_ID) return;

    const item = unscheduled.find((i) => i.id === parsed.id && i.kind === parsed.kind);
    if (item) setScheduleTarget(item);
  }

  function handleScheduled() {
    setUnscheduled((prev) => prev.filter((i) => i !== scheduleTarget));
    router.refresh();
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex flex-col gap-3 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {undatedCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {`${undatedCount} item${undatedCount === 1 ? "" : "s"} ${undatedCount === 1 ? "has" : "have"} no dates yet — shown below with a dashed outline. Drag or resize ${undatedCount === 1 ? "it" : "them"} to schedule.`}
            </p>
          ) : (
            <span />
          )}

          <Tabs value={zoomLevel} onValueChange={(value) => setZoomLevel(value as ZoomLevel)}>
            <TabsList>
              {ZOOM_LEVEL_ORDER.map((level) => (
                <TabsTrigger key={level} value={level} className="text-xs px-2.5">
                  {ZOOM_LEVELS[level].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <GanttDropZone>
          {tasks.length === 0 ? (
            <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-300/70 py-16 text-sm text-slate-400">
              No items on the roadmap yet. Drag an item from below onto this area to schedule it.
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
                  // Remounted on zoom change (key={zoomLevel}) rather than left to
                  // react to scales/cellWidth prop diffs: the library derives and
                  // caches layout state from the scales it was initialized with,
                  // and nothing in its docs/types guarantees that's safe to swap
                  // live. A clean remount sidesteps that question entirely — the
                  // only cost is losing horizontal scroll position across a zoom
                  // change, which is a reasonable tradeoff since you're
                  // re-orienting the view anyway. Manually verified switching
                  // through all five levels and back renders correctly each time.
                  key={zoomLevel}
                  tasks={tasks}
                  scales={zoom.scales}
                  cellWidth={zoom.cellWidth}
                  // @ts-expect-error taskTemplate typing from the library expects its own ITask shape
                  taskTemplate={(props) => <TaskBar {...props} />}
                  onUpdateTask={handleUpdateTask}
                />
              </div>
            </div>
          )}
        </GanttDropZone>

        <UnscheduledItemsPanel items={unscheduled} onQuickAdd={handleQuickAdd} />
      </div>

      <ScheduleItemDialog
        item={scheduleTarget}
        workspaceId={workspaceId}
        revalidatePathStr={revalidatePathStr}
        onOpenChange={(open) => {
          if (!open) setScheduleTarget(null);
        }}
        onScheduled={handleScheduled}
      />
    </DndContext>
  );
}

function GanttDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: GANTT_DROP_ZONE_ID });
  return (
    <div
      ref={setNodeRef}
      id={GANTT_DROP_ZONE_ID}
      className={`rounded-xl transition-shadow ${isOver ? "ring-2 ring-indigo-300" : ""}`}
    >
      {children}
    </div>
  );
}
