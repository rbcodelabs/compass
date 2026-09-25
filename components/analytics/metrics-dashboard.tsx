"use client";

import { useCallback, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import {
  CheckCircle2Icon,
  AlertTriangleIcon,
  XCircleIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PlusIcon,
  PencilIcon,
  ArchiveIcon,
  EyeOffIcon,
} from "lucide-react";
import type { DashboardMetricDTO, MetricDTO, MetricInput } from "@/lib/analytics/service";
import { unwrapAnalyticsAction } from "@/lib/analytics/action-result";
import { clampLayout, sizeBucket, SIZE_PRESET, DASHBOARD_GRID, DEFAULT_DASHBOARD_STATE, type SizeBucket } from "@/lib/analytics/dashboard-layout";
import {
  resizeDashboardMetric,
  setDashboardMetricVisible,
  reorderDashboardMetric,
} from "@/app/[orgSlug]/[workspaceSlug]/metrics/actions";
// Create/edit/archive reuse the existing analytics server actions verbatim
// (moved off the Settings panel, not duplicated) -- see analytics-actions.ts.
import {
  createAnalyticsMetric,
  editAnalyticsMetric,
  archiveAnalyticsMetric,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions";
import { usePanelContext, type EntityPanelType } from "@/components/panels/panel-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const PANEL_TYPE_FOR_TARGET: Record<DashboardMetricDTO["bindings"][number]["targetType"], EntityPanelType> = {
  EXPERIMENT: "experiment",
  ROADMAP_ITEM: "roadmapItem",
  KEY_RESULT: "keyResult",
};

function errorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known: Record<string, string> = {
    AUTHENTICATION: "Vercel rejected that access token.",
    ACCESS_DENIED: "That account cannot access this Vercel project.",
    PROJECT_NOT_FOUND: "Vercel could not find that project.",
    ANALYTICS_DISABLED: "Web Analytics is not enabled for that project.",
    PLAN_REQUIRED: "This query requires a Vercel plan with Web Analytics access.",
    REVISION_CONFLICT: "This metric changed elsewhere. Reload before editing it again.",
    METRIC_ARCHIVED: "This metric is already archived.",
    INVALID_INPUT: "Check the metric fields and try again.",
    NOT_FOUND_OR_ACCESS_DENIED: "This metric is no longer available. Reload the page.",
  };
  return known[code] ?? "The change could not be saved. Try again.";
}

type MetricKind = "pageviews" | "daily_visitors" | "event_count";

function metricKind(metric?: MetricDTO): MetricKind {
  const value = metric?.query.metric;
  return value === "daily_visitors" || value === "event_count" ? value : "pageviews";
}

export function MetricsDashboard({
  orgSlug,
  workspaceSlug,
  initialMetrics,
  vercelConnectionId,
}: {
  orgSlug: string;
  workspaceSlug: string;
  initialMetrics: DashboardMetricDTO[];
  vercelConnectionId: string | null;
}) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [metricDialogOpen, setMetricDialogOpen] = useState(false);
  const [editingMetric, setEditingMetric] = useState<MetricDTO | null>(null);
  const [archiving, setArchiving] = useState<DashboardMetricDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const gridRef = useRef<HTMLDivElement>(null);
  const dragIdRef = useRef<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const visible = useMemo(() => metrics.filter((row) => row.dashboardVisible), [metrics]);
  const hidden = useMemo(() => metrics.filter((row) => !row.dashboardVisible), [metrics]);
  const freshCount = useMemo(() => metrics.filter((row) => row.status === "fresh").length, [metrics]);
  const attentionCount = metrics.length - freshCount;

  function patch(id: string, update: Partial<DashboardMetricDTO>) {
    setMetrics((current) => current.map((row) => (row.metric.id === id ? { ...row, ...update } : row)));
  }

  function openCreate() {
    setError(null);
    setEditingMetric(null);
    setMetricDialogOpen(true);
  }

  function openEdit(row: DashboardMetricDTO) {
    setError(null);
    setEditingMetric(row.metric);
    setMetricDialogOpen(true);
  }

  function saveMetric(input: MetricInput) {
    setError(null);
    startTransition(async () => {
      try {
        if (editingMetric) {
          // editAnalyticsMetric only changes name/unit/query -- layout, status,
          // and bindings are untouched, so patching just the nested `metric`
          // is correct without a second round trip.
          const saved = unwrapAnalyticsAction(await editAnalyticsMetric(orgSlug, workspaceSlug, editingMetric.id, { ...input, expectedRevision: editingMetric.revision }));
          patch(saved.id, { metric: saved });
        } else {
          const saved = unwrapAnalyticsAction(await createAnalyticsMetric(orgSlug, workspaceSlug, input));
          // createAnalyticsMetric returns the metric definition only; the
          // dashboard layout it lands with is exactly today's defaults
          // (visible, medium, appended last) -- see DEFAULT_DASHBOARD_STATE
          // and metricDefinition.create's schema defaults in service.ts, so
          // this can be synthesized locally instead of a second fetch.
          const created: DashboardMetricDTO = {
            id: saved.id,
            dashboardVisible: DEFAULT_DASHBOARD_STATE.visible,
            dashboardCol: DEFAULT_DASHBOARD_STATE.col,
            dashboardRow: DEFAULT_DASHBOARD_STATE.row,
            dashboardSortOrder: DEFAULT_DASHBOARD_STATE.sortOrder,
            metric: saved,
            status: "fresh",
            statusCaption: "Not yet linked to a metric binding",
            value: null,
            delta: null,
            sparkline: [],
            bindings: [],
          };
          setMetrics((current) => [...current.filter((row) => row.metric.id !== created.metric.id), created]);
        }
        setMetricDialogOpen(false);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function confirmArchive() {
    if (!archiving) return;
    const target = archiving;
    setError(null);
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await archiveAnalyticsMetric(orgSlug, workspaceSlug, target.metric.id));
        setMetrics((current) => current.filter((row) => row.metric.id !== target.metric.id));
        setArchiving(null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function removeFromDashboard(row: DashboardMetricDTO) {
    setError(null);
    patch(row.metric.id, { dashboardVisible: false });
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await setDashboardMetricVisible(orgSlug, workspaceSlug, row.metric.id, false));
      } catch (cause) {
        patch(row.metric.id, { dashboardVisible: true });
        setError(errorMessage(cause));
      }
    });
  }

  function addToDashboard(row: DashboardMetricDTO) {
    setError(null);
    startTransition(async () => {
      try {
        const layout = unwrapAnalyticsAction(await setDashboardMetricVisible(orgSlug, workspaceSlug, row.metric.id, true));
        patch(row.metric.id, layout);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function applySize(row: DashboardMetricDTO, preset: SizeBucket) {
    const { col, row: r } = SIZE_PRESET[preset];
    const previous = { dashboardCol: row.dashboardCol, dashboardRow: row.dashboardRow };
    patch(row.metric.id, { dashboardCol: col, dashboardRow: r });
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await resizeDashboardMetric(orgSlug, workspaceSlug, row.metric.id, { col, row: r }));
      } catch (cause) {
        patch(row.metric.id, previous);
        setError(errorMessage(cause));
      }
    });
  }

  const commitResize = useCallback(
    (id: string, next: { col: number; row: number }) => {
      const previousRow = metrics.find((row) => row.metric.id === id);
      // Optimistic first, like applySize below: the drag handle already shows
      // `next` live during the gesture, so patching immediately keeps the
      // committed card in sync with props instead of springing back to the
      // pre-drag size for the round trip.
      patch(id, { dashboardCol: next.col, dashboardRow: next.row });
      startTransition(async () => {
        try {
          unwrapAnalyticsAction(await resizeDashboardMetric(orgSlug, workspaceSlug, id, next));
        } catch (cause) {
          if (previousRow) patch(id, { dashboardCol: previousRow.dashboardCol, dashboardRow: previousRow.dashboardRow });
          setError(errorMessage(cause));
        }
      });
    },
    [orgSlug, workspaceSlug, metrics]
  );

  function onDragStart(id: string) {
    dragIdRef.current = id;
  }
  function onDragOver(event: React.DragEvent, overId: string) {
    if (!dragIdRef.current || dragIdRef.current === overId) return;
    event.preventDefault();
    setDropTargetId(overId);
  }
  function onDrop(event: React.DragEvent, overId: string) {
    event.preventDefault();
    const draggedId = dragIdRef.current;
    dragIdRef.current = null;
    setDropTargetId(null);
    if (!draggedId || draggedId === overId) return;
    // Compute the reordered array from the current `metrics` state and commit
    // it as a plain, synchronous setMetrics call. The server-persistence call
    // (startTransition) is a separate statement AFTER that commit, never
    // nested inside the setMetrics updater -- React invokes updater
    // functions during the render phase, and calling startTransition from
    // inside one throws "Cannot call startTransition while rendering" (which
    // then cascades into a router update-during-render error and trips the
    // page's error boundary). See the "drag-to-reorder ... without crashing
    // the page" test in metrics-dashboard.spec.ts for the regression test.
    const previous = metrics;
    const fromIndex = previous.findIndex((row) => row.metric.id === draggedId);
    const overIndex = previous.findIndex((row) => row.metric.id === overId);
    if (fromIndex === -1 || overIndex === -1) return;
    const next = [...previous];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(overIndex, 0, moved);
    const newVisibleIndex = next.filter((row) => row.dashboardVisible).findIndex((row) => row.metric.id === draggedId);
    setMetrics(next);
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await reorderDashboardMetric(orgSlug, workspaceSlug, draggedId, newVisibleIndex));
      } catch (cause) {
        setMetrics(previous);
        setError(errorMessage(cause));
      }
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-subtle">
          {vercelConnectionId ? "Vercel Web Analytics is connected as this workspace's analytics provider." : "Connect Vercel Web Analytics in Settings to define metrics."}
        </p>
        <Button onClick={openCreate} disabled={!vercelConnectionId}>
          <PlusIcon />
          New metric
        </Button>
      </div>

      {error && <p role="alert" className="rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="metrics-summary">
        <SummaryTile label="Total metrics" value={metrics.length} sub={`${visible.length} on this dashboard · ${hidden.length} hidden`} />
        <SummaryTile label="Fresh" value={freshCount} sub="Synced within the current window" />
        <SummaryTile label="Needs attention" value={attentionCount} sub="Stale or failed — shown as unavailable, never zero" attention={attentionCount > 0} />
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-default px-6 py-12 text-center">
          <p className="font-medium text-text-primary">No metrics on this dashboard yet</p>
          <p className="max-w-md text-sm text-text-subtle">Create a metric to connect product usage from Vercel Web Analytics to an experiment, key result, or roadmap launch.</p>
          <Button onClick={openCreate} disabled={!vercelConnectionId}>
            <PlusIcon />
            Create your first metric
          </Button>
        </div>
      ) : (
        <div ref={gridRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" style={{ gridAutoRows: "64px", gridAutoFlow: "dense" }} data-testid="metrics-grid">
          {visible.map((row) => (
            <MetricCard
              key={row.metric.id}
              row={row}
              isDropTarget={dropTargetId === row.metric.id}
              gridRef={gridRef}
              onDragStart={() => onDragStart(row.metric.id)}
              onDragOver={(event) => onDragOver(event, row.metric.id)}
              onDrop={(event) => onDrop(event, row.metric.id)}
              onDragEnd={() => { dragIdRef.current = null; setDropTargetId(null); }}
              onResizeEnd={(next) => commitResize(row.metric.id, next)}
              onSize={(preset) => applySize(row, preset)}
              onEdit={() => openEdit(row)}
              onRemove={() => removeFromDashboard(row)}
              onArchive={() => setArchiving(row)}
            />
          ))}
          <AddWidgetTile hidden={hidden} onAddExisting={addToDashboard} onCreateNew={openCreate} createDisabled={!vercelConnectionId} />
        </div>
      )}

      {metricDialogOpen && (
        <MetricDialog
          open
          onOpenChange={setMetricDialogOpen}
          metric={editingMetric}
          vercelConnectionId={vercelConnectionId}
          pending={isPending}
          error={error}
          onSubmit={saveMetric}
        />
      )}

      <AlertDialog open={Boolean(archiving)} onOpenChange={(open) => { if (!open) setArchiving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiving ? `"${archiving.metric.name}"` : "this metric"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This metric will stop appearing in new bindings, but its historical observations and existing links to experiments, key results, and roadmap items are preserved — nothing is deleted, and a stale metric never becomes a silent zero.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmArchive} disabled={isPending}>Archive metric</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryTile({ label, value, sub, attention }: { label: string; value: number; sub: string; attention?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${attention ? "border-status-warning/40 bg-status-warning-surface" : "border-border-default bg-surface-panel"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-subtle">{sub}</p>
    </div>
  );
}

const STATUS_CONFIG = {
  fresh: { Icon: CheckCircle2Icon, label: "Fresh", className: "text-status-success" },
  stale: { Icon: AlertTriangleIcon, label: "Stale", className: "text-status-warning" },
  failed: { Icon: XCircleIcon, label: "Failed", className: "text-status-danger" },
} as const;

function StatusPill({ status, caption }: { status: DashboardMetricDTO["status"]; caption: string }) {
  const { Icon, label, className } = STATUS_CONFIG[status];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`inline-flex items-center gap-1 font-medium ${className}`}>
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
      <span className="text-text-subtle">{caption}</span>
    </div>
  );
}

function Sparkline({ points }: { points: (number | null)[] }) {
  const w = 100, h = 32, pad = 3;
  if (points.length === 0 || points.every((point) => point == null)) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full text-border-strong" aria-hidden="true" preserveAspectRatio="none">
        <line x1={pad} y1={h / 2} x2={w - pad} y2={h / 2} stroke="currentColor" strokeWidth={2} strokeDasharray="3 3" strokeLinecap="round" />
      </svg>
    );
  }
  const known = points.filter((point): point is number => point != null);
  const min = Math.min(...known), max = Math.max(...known);
  const range = max - min || 1;
  let lastKnownIndex = 0;
  for (let index = 0; index < points.length; index++) if (points[index] != null) lastKnownIndex = index;
  const coords = points.map((point, index) => ({
    x: pad + (index / Math.max(1, points.length - 1)) * (w - pad * 2),
    y: point == null ? null : h - pad - ((point - min) / range) * (h - pad * 2),
  }));
  const path = coords
    .slice(0, lastKnownIndex + 1)
    .filter((c) => c.y != null)
    .map((c, index) => `${index === 0 ? "M" : "L"}${c.x.toFixed(1)},${(c.y as number).toFixed(1)}`)
    .join(" ");
  const last = coords[lastKnownIndex];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full text-primary" aria-hidden="true" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.6} />
      {last?.y != null && <circle cx={last.x} cy={last.y} r={2.4} fill="currentColor" />}
    </svg>
  );
}

const TARGET_LABEL: Record<DashboardMetricDTO["bindings"][number]["targetType"], string> = {
  EXPERIMENT: "Experiment",
  KEY_RESULT: "Key result",
  ROADMAP_ITEM: "Roadmap item",
};

function BindingsRow({ bindings }: { bindings: DashboardMetricDTO["bindings"] }) {
  const { openPanel } = usePanelContext();
  if (bindings.length === 0) return <p className="text-xs text-text-subtle">Not linked yet</p>;
  const shown = bindings.slice(0, 2);
  const rest = bindings.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((binding) => (
        <button
          key={binding.id}
          type="button"
          className="max-w-40 truncate rounded-full border border-border-default bg-surface-inset px-2 py-0.5 text-xs text-text-secondary hover:bg-muted"
          title={`${TARGET_LABEL[binding.targetType]}: ${binding.targetTitle}`}
          onClick={() => openPanel(PANEL_TYPE_FOR_TARGET[binding.targetType], binding.targetId)}
        >
          {binding.targetTitle}
        </button>
      ))}
      {rest > 0 && <Badge variant="outline">+{rest} more</Badge>}
    </div>
  );
}

function MetricCard({
  row,
  isDropTarget,
  gridRef,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onResizeEnd,
  onSize,
  onEdit,
  onRemove,
  onArchive,
}: {
  row: DashboardMetricDTO;
  isDropTarget: boolean;
  gridRef: React.RefObject<HTMLDivElement | null>;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onResizeEnd: (next: { col: number; row: number }) => void;
  onSize: (preset: SizeBucket) => void;
  onEdit: () => void;
  onRemove: () => void;
  onArchive: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Only set while a pointer-drag resize is in flight; overrides the
  // prop-driven size for live visual feedback. `null` the rest of the time so
  // a menu preset click (which updates `row.dashboardCol/Row` in the parent)
  // is reflected immediately instead of being masked by a stale local copy.
  const [dragPreview, setDragPreview] = useState<{ col: number; row: number } | null>(null);
  const col = dragPreview?.col ?? row.dashboardCol;
  const cardRow = dragPreview?.row ?? row.dashboardRow;
  const bucket = sizeBucket(col, cardRow);

  function onResizePointerDown(event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const colWidth = (grid.clientWidth - 16 * (DASHBOARD_GRID.cols - 1)) / DASHBOARD_GRID.cols;
    const startX = event.clientX, startY = event.clientY;
    const startCol = row.dashboardCol, startRow = row.dashboardRow;
    let pending = { col: startCol, row: startRow };
    function onMove(ev: PointerEvent) {
      const deltaCol = Math.round((ev.clientX - startX) / (colWidth + 16));
      const deltaRow = Math.round((ev.clientY - startY) / (64 + 16));
      pending = clampLayout({ col: startCol + deltaCol, row: startRow + deltaRow });
      setDragPreview(pending);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // commitResize patches the parent's row synchronously (optimistic),
      // so clearing the preview here hands off to props with no flash back
      // to the pre-drag size.
      setDragPreview(null);
      if (pending.col !== row.dashboardCol || pending.row !== row.dashboardRow) onResizeEnd(pending);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={cardRef}
      data-testid="metric-card"
      data-metric-name={row.metric.name}
      data-size={bucket}
      className={`relative flex flex-col overflow-hidden rounded-xl border bg-surface-panel ${isDropTarget ? "border-primary" : "border-border-default"}`}
      style={{ gridColumn: `span ${col}`, gridRow: `span ${cardRow}` }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        data-testid="metric-card-drag-handle"
        className="flex cursor-grab items-start justify-between gap-2 border-b border-border-default px-3 py-2 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary" title={row.metric.name}>{row.metric.name}</p>
          <p className="mt-0.5 text-[11px] text-text-subtle">{row.metric.query.metric.replaceAll("_", " ")} · {row.metric.provider === "vercel" ? "Vercel" : "Compass"}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${row.metric.name} card options`} />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <div className="flex items-center gap-1 px-1.5 py-1">
              {(["sm", "md", "lg"] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  data-testid={`resize-${preset}`}
                  onClick={() => onSize(preset)}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium uppercase ${bucket === preset ? "border-primary bg-primary/10 text-primary" : "border-border-default text-text-secondary hover:bg-muted"}`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEdit}><PencilIcon />Edit metric</DropdownMenuItem>
            <DropdownMenuItem onClick={onRemove}><EyeOffIcon />Remove from dashboard</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onArchive}><ArchiveIcon />Archive metric</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-3 py-2">
        <StatusPill status={row.status} caption={row.statusCaption} />
        {row.value == null ? (
          // "last sync failed" is only true when the status actually is
          // failed -- a brand-new "fresh" metric that simply has no
          // observation yet must not show the same alarming copy next to
          // its green pill. row.statusCaption already carries the specific
          // reason and is shown by StatusPill above, so this stays generic.
          <p className="text-sm text-text-subtle">{row.status === "failed" ? "Unavailable — last sync failed" : "Unavailable"}</p>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-semibold tabular-nums ${row.status === "stale" ? "text-text-subtle" : "text-text-primary"}`}>{row.value}</span>
            <span className="text-xs text-text-subtle">{row.metric.unit}</span>
            {row.delta && bucket !== "sm" && (
              <span className={`text-xs font-medium ${row.delta.direction === "up" ? "text-status-success" : "text-status-danger"}`}>
                {row.delta.direction === "up" ? "↑" : "↓"} {row.delta.diff > 0 ? "+" : ""}{row.delta.diff}
              </span>
            )}
          </div>
        )}
        {bucket !== "sm" && <Sparkline points={row.sparkline} />}
        {bucket === "lg" && <BindingsRow bindings={row.bindings} />}
      </div>

      <button
        type="button"
        aria-label="Resize card"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
        className="absolute bottom-1 right-1 flex size-5 cursor-nwse-resize items-center justify-center rounded text-text-subtle hover:bg-muted hover:text-text-primary"
      >
        <GripVerticalIcon className="size-3.5 rotate-45" />
      </button>
    </div>
  );
}

function AddWidgetTile({
  hidden,
  onAddExisting,
  onCreateNew,
  createDisabled,
}: {
  hidden: DashboardMetricDTO[];
  onAddExisting: (row: DashboardMetricDTO) => void;
  onCreateNew: () => void;
  createDisabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-testid="add-widget-tile"
            style={{ gridColumn: "span 1", gridRow: "span 2" }}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-default text-sm text-text-subtle hover:border-primary hover:text-primary"
          />
        }
      >
        <PlusIcon className="size-4" />
        <span>Add widget{hidden.length > 0 ? ` (${hidden.length})` : ""}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {hidden.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-subtle">Every defined metric is already on this dashboard.</p>
        ) : (
          hidden.map((row) => (
            <DropdownMenuItem key={row.metric.id} onClick={() => onAddExisting(row)}>
              <span className="min-w-0 flex-1 truncate">{row.metric.name}</span>
              <Badge variant="outline">{row.metric.provider === "vercel" ? "Vercel" : "Compass"}</Badge>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCreateNew} disabled={createDisabled}>
          <PlusIcon />
          Create a new metric…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MetricDialog({
  open,
  onOpenChange,
  metric,
  vercelConnectionId,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metric: MetricDTO | null;
  vercelConnectionId: string | null;
  pending: boolean;
  error: string | null;
  onSubmit: (input: MetricInput) => void;
}) {
  const [kind, setKind] = useState<MetricKind>(metricKind(metric ?? undefined));
  const key = metric ? `${metric.id}:${metric.revision}` : "new";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const eventName = String(formData.get("eventName") ?? "").trim();
    const action = String(formData.get("action") ?? "").trim();
    const path = String(formData.get("path") ?? "").trim();
    const query: MetricInput["query"] = {
      metric: kind,
      ...(kind === "event_count" && eventName ? { eventName } : {}),
      ...(kind !== "event_count" && path ? { path } : {}),
      ...(kind === "event_count" && action ? { eventProperties: { action } } : {}),
    };
    onSubmit({
      name: String(formData.get("name") ?? ""),
      unit: String(formData.get("unit") ?? ""),
      provider: "vercel",
      connectionId: metric?.connectionId ?? vercelConnectionId ?? undefined,
      query,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={key} className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{metric ? "Edit metric" : "Create metric"}</DialogTitle>
            <DialogDescription>Define a metric sourced from your connected analytics provider.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5"><Label htmlFor={`dash-metric-name-${key}`}>Name</Label><Input id={`dash-metric-name-${key}`} name="name" required defaultValue={metric?.name ?? ""} placeholder="e.g. Signup completion rate" /></div>
            <div className="grid gap-1.5"><Label htmlFor={`dash-metric-unit-${key}`}>Unit</Label><Input id={`dash-metric-unit-${key}`} name="unit" required defaultValue={metric?.unit ?? "views"} /></div>
            <div className="grid gap-1.5">
              <Label htmlFor={`dash-metric-measure-${key}`}>Measure</Label>
              <select id={`dash-metric-measure-${key}`} name="measure" value={kind} onChange={(event) => setKind(event.target.value as MetricKind)} className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm">
                <option value="pageviews">Pageviews</option>
                <option value="daily_visitors">Daily visitors</option>
                <option value="event_count">Custom event count</option>
              </select>
            </div>
            {kind === "event_count" ? (
              <>
                <div className="grid gap-1.5"><Label htmlFor={`dash-metric-event-${key}`}>Event name</Label><Input id={`dash-metric-event-${key}`} name="eventName" required defaultValue={metric?.query.eventName ?? ""} /></div>
                <div className="grid gap-1.5"><Label htmlFor={`dash-metric-action-${key}`}>Action filter (optional)</Label><Input id={`dash-metric-action-${key}`} name="action" defaultValue={metric?.query.eventProperties?.action ?? ""} /></div>
              </>
            ) : (
              <div className="grid gap-1.5"><Label htmlFor={`dash-metric-path-${key}`}>Path filter (optional)</Label><Input id={`dash-metric-path-${key}`} name="path" placeholder="/roadmap" defaultValue={metric?.query.path ?? ""} /></div>
            )}
            <p className="text-xs leading-5 text-text-subtle">No user identifiers or free-text product content are supported.</p>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? "Saving…" : metric ? "Save changes" : "Create metric"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
