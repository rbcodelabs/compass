"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import type { BindingDTO, MetricDTO, MetricTarget, ObservationDTO } from "@/lib/analytics/service";
import {
  linkAnalyticsMetric,
  refreshAnalyticsMeasurement,
  updateAnalyticsMeasurement,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions";
import { listAnalyticsMetrics, readMeasurements } from "@/lib/analytics/measurement-reads";
import { unwrapAnalyticsAction } from "@/lib/analytics/action-result";
import { DAY_MS, validateWindow, type MetricWindow } from "@/lib/analytics/providers";
import type { RollingWindow } from "@/lib/analytics/windows";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type Measurement = { binding: BindingDTO; observations: ObservationDTO[] };

function readableError(error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known: Record<string, string> = {
    DISCONNECTED: "Reconnect the metric's provider before refreshing. Existing evidence has been preserved.",
    CONNECTION_CHANGED: "The provider connection changed during refresh. Try again.",
    PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable. Existing evidence has been preserved.",
    RATE_LIMITED: "The provider rate-limited this refresh. Try again later.",
    DATA_UNAVAILABLE: "The provider no longer has data for this window.",
    INVALID_WINDOW: "Choose valid UTC date windows of 90 days or fewer.",
    INVALID_INPUT: "Check the measurement fields and try again.",
    AUTHENTICATION: "Vercel rejected the saved token. Reconnect the provider in Settings → Analytics.",
    ACCESS_DENIED: "The saved token cannot access this Vercel project.",
    ANALYTICS_DISABLED: "Enable Web Analytics for this project in Vercel, then refresh again.",
    PLAN_REQUIRED: "This query requires a Vercel plan with Web Analytics access.",
    PROJECT_NOT_FOUND: "Vercel could not find the connected project.",
    BINDING_INACTIVE: "This measurement was changed elsewhere. Reload the record.",
    METRIC_ARCHIVED: "This metric is archived. Existing evidence has been preserved.",
    ENCRYPTION_NOT_CONFIGURED: "Analytics credential storage is not configured. Contact your Compass administrator.",
    PRODUCTION_ONLY: "Active Discovery Teams snapshots are available only in production.",
    ACTIVATION_WINDOW: "Active Discovery Teams supports only the current trailing 30-day snapshot.",
  };
  return known[code] ?? "The measurement could not be refreshed. Existing evidence has been preserved.";
}

function latest(observations: ObservationDTO[], kind: "BASELINE" | "FOLLOWUP") {
  return observations.find((observation) => observation.windowKind === kind) ?? null;
}

function observedWindow(observation: ObservationDTO | null, fallback: { since: string; until: string }) {
  const candidate = observation?.snapshot.window;
  if (!candidate || typeof candidate !== "object") return fallback;
  const value = candidate as { since?: unknown; until?: unknown };
  return typeof value.since === "string" && typeof value.until === "string"
    ? { since: value.since, until: value.until }
    : fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function formatWindow(since: string, until: string) {
  return `${formatDate(since)} – ${formatDate(until)} UTC`;
}

export function MeasurementsPanel({ orgSlug, workspaceSlug, target, compact = false }: { orgSlug: string; workspaceSlug: string; target: MetricTarget; compact?: boolean }) {
  const { targetId, targetType } = target;
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [metrics, setMetrics] = useState<MetricDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [mode, setMode] = useState<"tracking" | "comparison">("tracking");
  const [comparing, setComparing] = useState<BindingDTO | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [selectedMetricId, setSelectedMetricId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [rows, definitions] = await Promise.all([
        readMeasurements(orgSlug, workspaceSlug, { targetId, targetType }),
        listAnalyticsMetrics(orgSlug, workspaceSlug),
      ]);
      setMeasurements(rows);
      setMetrics(definitions.filter((metric) => !metric.archived));
    } catch {
      setLoadError("Measurements could not be loaded. Try reloading this record.");
    } finally {
      setLoading(false);
    }
  }, [orgSlug, targetId, targetType, workspaceSlug]);

  useEffect(() => { void load(); }, [load]);

  const linkable = useMemo(() => metrics.filter((metric) => !measurements.some((row) => row.binding.metricId === metric.id)), [measurements, metrics]);
  const nativeSelection = (linkable.find((metric) => metric.id === selectedMetricId) ?? linkable[0])?.provider === "compass_activation";

  function link(formData: FormData) {
    const baseline = { since: String(formData.get("baselineSince") ?? ""), until: String(formData.get("baselineUntil") ?? "") };
    const followup = { since: String(formData.get("followupSince") ?? ""), until: String(formData.get("followupUntil") ?? "") };
    const invalid: Record<string, string> = {};
    if (mode === "comparison") {
      for (const [name, label, window] of [["baseline", "baseline", baseline], ["followup", "follow-up", followup]] as const) {
        if (!window.since || !window.until) invalid[name] = `Choose both ${label} dates.`;
        else {
          try { validateWindow(window); }
          catch { invalid[name] = `Choose valid ${label} dates, with the end on or after the start and no more than 90 days inclusive.`; }
        }
      }
    }
    setFieldErrors(invalid);
    setErrors((current) => ({ ...current, link: "" }));
    if (Object.keys(invalid).length) return;
    const windows = mode === "comparison" ? { baseline, followup } : { baseline: null, followup: { version: 1 as const, mode: "rolling" as const, days: Number(formData.get("days") ?? 30) as RollingWindow["days"] } };
    startTransition(async () => {
      try {
        const binding = unwrapAnalyticsAction(comparing
          ? await updateAnalyticsMeasurement(orgSlug, workspaceSlug, comparing.id, windows)
          : await linkAnalyticsMetric(orgSlug, workspaceSlug, {
          targetId,
          targetType,
          metricId: String(formData.get("metricId")),
          ...windows,
        }));
        setMeasurements((current) => [...current.filter((row) => row.binding.id !== comparing?.id), { binding, observations: [] }]);
        setLinkOpen(false);
      } catch (cause) {
        setErrors((current) => ({ ...current, link: readableError(cause) }));
      }
    });
  }

  function refresh(bindingId: string) {
    setErrors((current) => ({ ...current, [bindingId]: "" }));
    startTransition(async () => {
      try {
        const observations = unwrapAnalyticsAction(await refreshAnalyticsMeasurement(orgSlug, workspaceSlug, bindingId, crypto.randomUUID()));
        setMeasurements((current) => current.map((row) => row.binding.id === bindingId
          ? { ...row, observations: [...observations, ...row.observations] }
          : row));
      } catch (cause) {
        setErrors((current) => ({ ...current, [bindingId]: readableError(cause) }));
      }
    });
  }

  return (
    <section className={compact ? "flex flex-col gap-3" : "flex flex-col gap-4"}>
      <div className="flex items-start justify-between gap-4">
        <div><h2 className={compact ? "text-xs font-semibold uppercase tracking-wider text-muted-foreground" : "text-base font-semibold"}>Measurements</h2>{!compact && <p className="mt-1 text-sm text-muted-foreground">Track usage now. Compare periods when you need to.</p>}</div>
        <Button variant="outline" size="sm" onClick={() => { setErrors((current) => ({ ...current, link: "" })); setFieldErrors({}); setComparing(null); setSelectedMetricId(null); setMode("tracking"); setLinkOpen(true); }} disabled={loading || linkable.length === 0}><PlusIcon />Link metric</Button>
      </div>

      {loadError && <p role="alert" className="rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{loadError}</p>}
      {loading ? <div className="h-24 animate-pulse rounded-xl bg-muted" /> : !loadError && measurements.length === 0 ? <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">No metrics linked yet. Track recent activity without a baseline, or compare two periods.</p> : measurements.map((row) => <MeasurementCard key={row.binding.id} row={row} error={errors[row.binding.id]} pending={isPending} onRefresh={() => refresh(row.binding.id)} onCompare={() => { setComparing(row.binding); setMode("comparison"); setFieldErrors({}); setErrors((current) => ({ ...current, link: "" })); setLinkOpen(true); }} compact={compact} />)}
      {!compact && <p className="text-xs leading-5 text-muted-foreground">Refresh captures a snapshot, not an automatic conclusion or key result update. Saved evidence keeps its original dates.</p>}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(event) => { event.preventDefault(); link(new FormData(event.currentTarget)); }} noValidate className="contents">
            <DialogHeader><DialogTitle>{comparing ? "Compare periods" : "Link measurement"}</DialogTitle><DialogDescription>{comparing ? "Choose comparison dates. Your previous tracking snapshots remain saved as evidence." : "Track recent activity without a baseline, or choose periods to compare."}</DialogDescription></DialogHeader>
            <div className="grid gap-4">
              {comparing ? <p className="font-medium">{comparing.metric.name}</p> : <><div className="grid gap-1.5"><Label htmlFor={`measurement-metric-${targetId}`}>Metric</Label><select id={`measurement-metric-${targetId}`} name="metricId" required onChange={(event) => setSelectedMetricId(event.target.value)} className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm">{linkable.map((metric) => <option key={metric.id} value={metric.id}>{metric.name}</option>)}</select></div>
                <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">How do you want to use it?</legend>{([['tracking', 'Track over time', 'See recent activity. No baseline needed.'], ['comparison', 'Compare periods', 'Compare a baseline with a follow-up.']] as const).map(([value, title, description]) => <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"><input type="radio" name="mode" value={value} checked={mode === value} onChange={() => { setMode(value); setFieldErrors({}); }} className="mt-1" /><span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{description}</span></span></label>)}</fieldset></>}
              {mode === "tracking" ? <div className="grid gap-1.5"><Label htmlFor={`tracking-window-${targetId}`}>Tracking window</Label><select id={`tracking-window-${targetId}`} name="days" key={String(nativeSelection)} defaultValue="30" className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm">{!nativeSelection && <option value="7">Last 7 days</option>}<option value="30">{nativeSelection ? "Current trailing 30 days" : "Last 30 days"}</option>{!nativeSelection && <option value="90">Last 90 days</option>}</select><p className="text-xs leading-5 text-muted-foreground">{nativeSelection ? "Captures the current trailing 30 × 24 hours, not calendar days through yesterday. Previously saved snapshots remain unchanged." : "Uses complete UTC days through yesterday. Dates advance on refresh; saved snapshots keep their original dates."}</p></div> : <>
                <div><p className="mb-2 text-sm font-medium">Baseline</p><div className="grid grid-cols-2 gap-3"><DateField id={`baseline-from-${targetId}`} name="baselineSince" label="Baseline from" errorId={fieldErrors.baseline ? `baseline-error-${targetId}` : undefined} /><DateField id={`baseline-through-${targetId}`} name="baselineUntil" label="Baseline through" errorId={fieldErrors.baseline ? `baseline-error-${targetId}` : undefined} /></div>{fieldErrors.baseline && <p id={`baseline-error-${targetId}`} role="alert" className="mt-1 text-xs text-status-danger">{fieldErrors.baseline}</p>}</div>
                <div><p className="mb-2 text-sm font-medium">Follow-up</p><div className="grid grid-cols-2 gap-3"><DateField id={`followup-from-${targetId}`} name="followupSince" label="Follow-up from" errorId={fieldErrors.followup ? `followup-error-${targetId}` : undefined} /><DateField id={`followup-through-${targetId}`} name="followupUntil" label="Follow-up through" errorId={fieldErrors.followup ? `followup-error-${targetId}` : undefined} /></div>{fieldErrors.followup && <p id={`followup-error-${targetId}`} role="alert" className="mt-1 text-xs text-status-danger">{fieldErrors.followup}</p>}</div>
                <p className="text-xs text-muted-foreground">Inclusive UTC dates. Each period can cover up to 90 days.</p>
              </>}
            </div>
            {errors.link && <p role="alert" className="text-sm text-status-danger">{errors.link}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setLinkOpen(false)}>Cancel</Button><Button type="submit" disabled={isPending || (!comparing && linkable.length === 0)}>{isPending ? "Saving…" : comparing ? "Save comparison" : "Link metric"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DateField({ id, name, label, errorId }: { id: string; name: string; label: string; errorId?: string }) {
  return <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label><Input id={id} name={name} type="date" required aria-invalid={!!errorId} aria-describedby={errorId} /></div>;
}

function MeasurementCard({ row, error, pending, onRefresh, onCompare, compact }: { row: Measurement; error?: string; pending: boolean; onRefresh: () => void; onCompare: () => void; compact: boolean }) {
  const baseline = latest(row.observations, "BASELINE");
  const followup = latest(row.observations, "FOLLOWUP");
  const completeness = row.binding.mode === "tracking" ? followup?.data.completeness : [baseline, followup].find((observation) => observation?.data.completeness !== "COMPLETE")?.data.completeness ?? (baseline && followup ? "COMPLETE" : null);
  const change = baseline?.data.value != null && followup?.data.value != null ? followup.data.value - baseline.data.value : null;
  return (
    <article data-testid="metric-measurement" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4"><div><h3 className="font-medium">{row.binding.metric.name}</h3><Badge variant="outline" className="mt-1">{row.binding.mode === "tracking" ? "Tracking" : "Comparison"}</Badge><p className="mt-1 text-xs text-muted-foreground">{row.binding.metric.provider === "vercel" ? "Vercel" : "Compass"} · {row.binding.metric.query.metric.replaceAll("_", " ")} · Revision {row.binding.metric.revision}</p></div><Button variant="outline" size="sm" onClick={onRefresh} disabled={pending}><RefreshCwIcon />Refresh</Button></div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{error}</p>}
      {row.binding.mode === "tracking" ? <TrackingValue observation={followup} binding={row.binding} /> : <div className={`mt-5 grid gap-4 ${compact ? "grid-cols-1" : "sm:grid-cols-3"}`}>
        <ObservationValue label="Baseline" window={observedWindow(baseline, row.binding.baseline)} logicalWindow={row.binding.baseline} observation={baseline} unit={row.binding.metric.unit} daily={row.binding.metric.query.metric === "daily_visitors"} />
        <ObservationValue label="Follow-up" window={observedWindow(followup, row.binding.followup)} logicalWindow={row.binding.followup} observation={followup} unit={row.binding.metric.unit} daily={row.binding.metric.query.metric === "daily_visitors"} />
        {!compact && <div><p className="text-xs text-muted-foreground">Observed change</p><p className="mt-2 text-2xl font-medium tabular-nums">{change === null ? "—" : `${change > 0 ? "+" : ""}${change}`} <span className="text-xs font-normal text-muted-foreground">{row.binding.metric.unit}</span></p></div>}
      </div>}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        {completeness && <Badge variant={completeness === "COMPLETE" ? "secondary" : "outline"}>{completeness === "COMPLETE" ? "Complete" : completeness === "PARTIAL" ? "Partial coverage" : "Unavailable"}</Badge>}
        {followup && <span>Retrieved {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(followup.retrievedAt))}</span>}
        {(baseline?.data.note || followup?.data.note) && <span>{followup?.data.note ?? baseline?.data.note}</span>}
        {row.binding.mode === "tracking" && <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={onCompare} disabled={pending}>Compare periods</Button>}
      </div>
    </article>
  );
}

function ObservationValue({ label, window, logicalWindow, observation, unit, daily }: { label: string; window: { since: string; until: string }; logicalWindow: { since: string; until: string }; observation: ObservationDTO | null; unit: string; daily: boolean }) {
  const differsFromRequest = window.since !== logicalWindow.since || window.until !== logicalWindow.until;
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-[11px] text-muted-foreground">{formatWindow(window.since, window.until)}</p>{differsFromRequest && <p className="mt-1 text-[11px] text-status-warning">Rolling snapshot; requested {formatWindow(logicalWindow.since, logicalWindow.until)}</p>}{daily && observation ? <div className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1" aria-label={`${label} daily visitors`}>{observation.data.series.map((point) => <div key={point.date} className="flex justify-between gap-3 text-xs tabular-nums"><span className="text-muted-foreground">{formatDate(point.date)}</span><span>{point.value} {unit}</span></div>)}</div> : <p className="mt-2 text-2xl font-medium tabular-nums">{observation?.data.value ?? "—"} <span className="text-xs font-normal text-muted-foreground">{unit}</span></p>}</div>;
}

function TrackingValue({ observation, binding }: { observation: ObservationDTO | null; binding: Extract<BindingDTO, { mode: "tracking" }> }) {
  const series = [...(observation?.data.series ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const last = series.at(-1);
  const native = binding.metric.provider === "compass_activation";
  const window = observedWindow(observation, { since: "", until: "" });
  const coverageStart = observation?.data.provenance?.coverageStart;
  const coverageEnd = observation?.data.provenance?.coverageEnd;
  return <div className="mt-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs text-muted-foreground">{native ? "Current snapshot" : last ? `Latest available day · ${formatDate(last.date)}` : "No observation yet"}</p><p className="mt-2 text-3xl font-medium tabular-nums">{native ? observation?.data.value ?? "—" : last?.value ?? "—"} <span className="text-sm font-normal text-muted-foreground">{binding.metric.unit}</span></p></div>
      <div className="text-xs text-muted-foreground"><p className="font-medium text-foreground">{native ? "Current trailing 30 days" : `Last ${binding.followup.days} days`}</p>{window.since && <p className="mt-1">{formatWindow(window.since, window.until)}</p>}<p className="mt-1">Window advances when refreshed</p></div>
    </div>
    {native ? typeof coverageStart === "string" && typeof coverageEnd === "string" && <p className="mt-3 text-xs text-muted-foreground">Snapshot coverage: {coverageStart} – {coverageEnd} (30 × 24 hours)</p> : <>
      {series.length > 0 && <DailyTrend series={series} window={window} />}
      <p className="mt-3 text-xs text-muted-foreground">{binding.metric.query.metric === "daily_visitors" ? "Visitors are shown per day—not added together as unique visitors for the period." : "Values are shown per day."} Missing data is not counted as zero.</p>
      {series.length > 0 && <Collapsible className="mt-3 text-xs"><CollapsibleTrigger type="button" className="cursor-pointer text-muted-foreground">Daily values</CollapsibleTrigger><CollapsibleContent><div className="mt-2 max-h-40 space-y-1 overflow-y-auto" aria-label="Tracking daily values">{series.map((point) => <div key={point.date} className="flex justify-between gap-3 tabular-nums"><span>{formatDate(point.date)}</span><span>{point.value} {binding.metric.unit}</span></div>)}</div></CollapsibleContent></Collapsible>}
    </>}
    {!observation && <p className="mt-3 text-xs text-muted-foreground">Refresh to capture your first snapshot. No baseline needed.</p>}
    {observation?.data.completeness === "UNAVAILABLE" && <p className="mt-3 text-xs text-muted-foreground">No data returned for this snapshot.</p>}
  </div>;
}

function DailyTrend({ series, window }: { series: { date: string; value: number }[]; window: MetricWindow }) {
  const start = Date.parse(window.since), end = Date.parse(window.until);
  const max = Math.max(1, ...series.map((point) => point.value));
  const pointPosition = (point: { date: string; value: number }) => ({ x: 4 + (Date.parse(point.date) - start) / Math.max(DAY_MS, end - start) * 692, y: 100 - point.value / max * 88 });
  // Missing days are separate path segments, not a line interpolating through invented data.
  const path = series.map((point, index) => { const { x, y } = pointPosition(point); return `${index === 0 || Date.parse(point.date) - Date.parse(series[index - 1].date) !== DAY_MS ? "M" : "L"}${x},${y}`; }).join(" ");
  return <svg viewBox="0 0 700 108" role="img" aria-label="Daily trend; gaps indicate missing data" className="mt-4 h-28 w-full text-primary"><path d="M0 100 H700 M0 56 H700 M0 12 H700" className="stroke-border" fill="none" /><path d={path} stroke="currentColor" strokeWidth="2" fill="none" />{series.map((point) => { const { x, y } = pointPosition(point); return <circle key={point.date} cx={x} cy={y} r="2" fill="currentColor"><title>{point.date}: {point.value}</title></circle>; })}</svg>;
}
