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
import { Lock } from "lucide-react";
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
  isPrivate: boolean;
  parent?: string | number;
};

// A synthetic row representing a group header (e.g. one per squad). Rendered
// as a `type: "summary"` row with real items nested under it via `parent` —
// tried nesting children with the library's own `data` array first (which
// its ITask type advertises for exactly this), but that crashed at render
// ("Cannot read properties of null (reading 'forEach')") in the installed
// free/OSS build. Flat array + `parent` id is what actually works — verified
// live before committing to this approach, since "task grouping" (the
// `group`/`GroupConfig` prop) is explicitly a Pro-only feature per the
// library's docs, and this doesn't use that prop at all.
type GanttGroupRow = {
  id: string;
  text: string;
  type: "summary";
  start: Date;
  end: Date;
  open: true;
  isGroup: true;
  groupColor: string | null;
};

type GanttRow = GanttTask | GanttGroupRow;

type TaskTemplateProps = {
  data: GanttRow;
};

// "Group by" is deliberately structured as a lookup of groupers rather than
// one hardcoded squad code path, so adding another dimension later (e.g.
// Opportunity) is "add a GROUPERS entry" rather than a rewrite. Only squad
// is wired up for now — it's the one dimension with existing filter-bar
// support and unambiguous grouping semantics.
const GROUP_BY_OPTIONS = ["none", "squad"] as const;
type GroupBy = (typeof GROUP_BY_OPTIONS)[number];
const GROUP_BY_LABELS: Record<GroupBy, string> = { none: "None", squad: "Squad" };

const UNASSIGNED_GROUP_KEY = "__unassigned";

type GroupInfo = { key: string; label: string; color: string | null };

const GROUPERS: Record<Exclude<GroupBy, "none">, (item: RoadmapCardData) => GroupInfo> = {
  squad: (item) =>
    item.squad
      ? { key: item.squad.id, label: item.squad.name, color: item.squad.color }
      : { key: UNASSIGNED_GROUP_KEY, label: "No squad", color: null },
};

// Synthetic group-row ids are prefixed so handleUpdateTask can recognize and
// ignore drag/resize events on them (their dates are a computed rollup of
// their children's dates, not a real persisted value).
const GROUP_ID_PREFIX = "group:";

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

const UNASSIGNED_GROUP_COLOR = "#94a3b8"; // slate-400, matches HORIZON_COLORS.LATER

function TaskBar({ data }: TaskTemplateProps) {
  if (data.type === "summary") {
    const color = data.groupColor ?? UNASSIGNED_GROUP_COLOR;
    return (
      <div
        style={{
          ...BAR_BASE_STYLE,
          backgroundColor: color,
          color: "#fff",
          fontWeight: 600,
          opacity: 0.85,
        }}
      >
        {data.text}
      </div>
    );
  }

  const color = HORIZON_COLORS[data.horizon] ?? HORIZON_COLORS.NOW;

  const privateIcon = data.isPrivate ? (
    <Lock
      className="mr-1 size-3 shrink-0"
      aria-label="Private — hidden from public portal roadmap"
    />
  ) : null;

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
        {privateIcon}
        {data.text}
        <span className="ml-1 shrink-0 opacity-70">(unscheduled)</span>
      </div>
    );
  }

  return (
    <div style={{ ...BAR_BASE_STYLE, backgroundColor: color, color: "#fff" }}>
      {privateIcon}
      {data.text}
    </div>
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
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

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

  const baseTasks: GanttTask[] = useMemo(
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
          isPrivate: item.isPrivate,
        };
      }),
    [items, placeholderStart, placeholderEnd]
  );

  // Grouped mode nests baseTasks under synthetic summary rows (one per
  // group, plus an "Unassigned"/"No squad" catch-all) rather than mutating
  // baseTasks itself, so ungrouped mode is untouched by this at all.
  const tasks: GanttRow[] = useMemo(() => {
    if (groupBy === "none") return baseTasks;

    const grouper = GROUPERS[groupBy];
    const order: string[] = [];
    const groups = new Map<string, { info: GroupInfo; children: GanttTask[] }>();
    items.forEach((item, i) => {
      const info = grouper(item);
      if (!groups.has(info.key)) {
        order.push(info.key);
        groups.set(info.key, { info, children: [] });
      }
      groups.get(info.key)!.children.push(baseTasks[i]);
    });

    // Alphabetical by label, with the "unassigned" bucket always last —
    // it's a catch-all, not a real group, so it doesn't belong sorted
    // alongside named ones.
    order.sort((a, b) => {
      if (a === UNASSIGNED_GROUP_KEY) return 1;
      if (b === UNASSIGNED_GROUP_KEY) return -1;
      return groups.get(a)!.info.label.localeCompare(groups.get(b)!.info.label);
    });

    const rows: GanttRow[] = [];
    for (const key of order) {
      const { info, children } = groups.get(key)!;
      const groupId = `${GROUP_ID_PREFIX}${groupBy}:${key}`;
      rows.push({
        id: groupId,
        text: `${info.label} (${children.length})`,
        type: "summary",
        start: new Date(Math.min(...children.map((c) => c.start.getTime()))),
        end: new Date(Math.max(...children.map((c) => c.end.getTime()))),
        open: true,
        isGroup: true,
        groupColor: info.color,
      });
      for (const child of children) rows.push({ ...child, parent: groupId });
    }
    return rows;
  }, [baseTasks, items, groupBy]);

  async function handleUpdateTask(ev: { id: string; task: { start?: Date; end?: Date } }) {
    // Group rows are a computed rollup of their children's dates, not a real
    // roadmap item — the free tier doesn't expose a way to make a row
    // non-draggable, so guard here instead of trying to persist a squad id
    // as though it were a RoadmapItem id.
    if (typeof ev.id === "string" && ev.id.startsWith(GROUP_ID_PREFIX)) return;
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

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Group by</span>
              <Tabs value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
                <TabsList>
                  {GROUP_BY_OPTIONS.map((option) => (
                    <TabsTrigger key={option} value={option} className="text-xs px-2.5">
                      {GROUP_BY_LABELS[option]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

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
                  // Remounted on zoom/group change rather than left to react to
                  // prop diffs: the library derives and caches layout state from
                  // the scales/task-tree it was initialized with, and nothing in
                  // its docs/types guarantees swapping either live is safe. A
                  // clean remount sidesteps that question entirely — the only
                  // cost is losing horizontal scroll position across a change,
                  // a reasonable tradeoff since you're re-orienting the view
                  // anyway. Manually verified switching through all five zoom
                  // levels and both group-by states renders correctly each time.
                  key={`${zoomLevel}:${groupBy}`}
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
