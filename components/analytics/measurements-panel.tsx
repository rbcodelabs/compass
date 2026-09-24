"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import type { BindingDTO, MetricDTO, MetricTarget, ObservationDTO } from "@/lib/analytics/service";
import {
  linkAnalyticsMetric,
  listAnalyticsMetrics,
  readMeasurements,
  refreshAnalyticsMeasurement,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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

  function link(formData: FormData) {
    startTransition(async () => {
      try {
        const binding = await linkAnalyticsMetric(orgSlug, workspaceSlug, {
          targetId,
          targetType,
          metricId: String(formData.get("metricId")),
          baseline: { since: String(formData.get("baselineSince")), until: String(formData.get("baselineUntil")) },
          followup: { since: String(formData.get("followupSince")), until: String(formData.get("followupUntil")) },
        });
        setMeasurements((current) => [...current, { binding, observations: [] }]);
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
        const observations = await refreshAnalyticsMeasurement(orgSlug, workspaceSlug, bindingId, crypto.randomUUID());
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
        <div><h2 className={compact ? "text-xs font-semibold uppercase tracking-wider text-muted-foreground" : "text-base font-semibold"}>Measurements</h2>{!compact && <p className="mt-1 text-sm text-muted-foreground">Usage is evidence, not an automatic experiment conclusion.</p>}</div>
        <Button variant="outline" size="sm" onClick={() => { setErrors((current) => ({ ...current, link: "" })); setLinkOpen(true); }} disabled={loading || linkable.length === 0}><PlusIcon />Link metric</Button>
      </div>

      {loadError && <p role="alert" className="rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{loadError}</p>}
      {loading ? <div className="h-24 animate-pulse rounded-xl bg-muted" /> : !loadError && measurements.length === 0 ? <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">No metrics linked yet. Add one to preserve explicit baseline and follow-up evidence.</p> : measurements.map((row) => <MeasurementCard key={row.binding.id} row={row} error={errors[row.binding.id]} pending={isPending} onRefresh={() => refresh(row.binding.id)} compact={compact} />)}
      {!compact && <p className="text-xs leading-5 text-muted-foreground">Dates are explicitly chosen. Roadmap due dates are never treated as launch dates. Refresh does not count as activity.</p>}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <form action={link} className="contents">
            <DialogHeader><DialogTitle>Link measurement</DialogTitle><DialogDescription>Choose comparable inclusive UTC windows around the real experiment or launch.</DialogDescription></DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-1.5"><Label htmlFor={`measurement-metric-${targetId}`}>Metric</Label><select id={`measurement-metric-${targetId}`} name="metricId" required className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm">{linkable.map((metric) => <option key={metric.id} value={metric.id}>{metric.name}</option>)}</select></div>
              <div><p className="mb-2 text-sm font-medium">Baseline</p><div className="grid grid-cols-2 gap-3"><DateField id={`baseline-from-${targetId}`} name="baselineSince" label="Baseline from" /><DateField id={`baseline-through-${targetId}`} name="baselineUntil" label="Baseline through" /></div></div>
              <div><p className="mb-2 text-sm font-medium">Follow-up</p><div className="grid grid-cols-2 gap-3"><DateField id={`followup-from-${targetId}`} name="followupSince" label="Follow-up from" /><DateField id={`followup-through-${targetId}`} name="followupUntil" label="Follow-up through" /></div></div>
            </div>
            {errors.link && <p role="alert" className="text-sm text-status-danger">{errors.link}</p>}
            <DialogFooter><Button type="submit" disabled={isPending || linkable.length === 0}>{isPending ? "Linking…" : "Link metric"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DateField({ id, name, label }: { id: string; name: string; label: string }) {
  return <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label><Input id={id} name={name} type="date" required /></div>;
}

function MeasurementCard({ row, error, pending, onRefresh, compact }: { row: Measurement; error?: string; pending: boolean; onRefresh: () => void; compact: boolean }) {
  const baseline = latest(row.observations, "BASELINE");
  const followup = latest(row.observations, "FOLLOWUP");
  const completeness = [baseline, followup].find((observation) => observation?.data.completeness !== "COMPLETE")?.data.completeness ?? (baseline && followup ? "COMPLETE" : null);
  const change = baseline?.data.value != null && followup?.data.value != null ? followup.data.value - baseline.data.value : null;
  return (
    <article data-testid="metric-measurement" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4"><div><h3 className="font-medium">{row.binding.metric.name}</h3><p className="mt-1 text-xs text-muted-foreground">{row.binding.metric.provider === "vercel" ? "Vercel" : "Compass"} · {row.binding.metric.query.metric.replaceAll("_", " ")} · Revision {row.binding.metric.revision}</p></div><Button variant="outline" size="sm" onClick={onRefresh} disabled={pending}><RefreshCwIcon />Refresh</Button></div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{error}</p>}
      <div className={`mt-5 grid gap-4 ${compact ? "grid-cols-1" : "sm:grid-cols-3"}`}>
        <ObservationValue label="Baseline" window={observedWindow(baseline, row.binding.baseline)} logicalWindow={row.binding.baseline} observation={baseline} unit={row.binding.metric.unit} daily={row.binding.metric.query.metric === "daily_visitors"} />
        <ObservationValue label="Follow-up" window={observedWindow(followup, row.binding.followup)} logicalWindow={row.binding.followup} observation={followup} unit={row.binding.metric.unit} daily={row.binding.metric.query.metric === "daily_visitors"} />
        {!compact && <div><p className="text-xs text-muted-foreground">Observed change</p><p className="mt-2 text-2xl font-medium tabular-nums">{change === null ? "—" : `${change > 0 ? "+" : ""}${change}`} <span className="text-xs font-normal text-muted-foreground">{row.binding.metric.unit}</span></p></div>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        {completeness && <Badge variant={completeness === "COMPLETE" ? "secondary" : "outline"}>{completeness === "COMPLETE" ? "Complete" : completeness === "PARTIAL" ? "Partial coverage" : "Unavailable"}</Badge>}
        {followup && <span>Retrieved {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(followup.retrievedAt))}</span>}
        {(baseline?.data.note || followup?.data.note) && <span>{followup?.data.note ?? baseline?.data.note}</span>}
      </div>
    </article>
  );
}

function ObservationValue({ label, window, logicalWindow, observation, unit, daily }: { label: string; window: { since: string; until: string }; logicalWindow: { since: string; until: string }; observation: ObservationDTO | null; unit: string; daily: boolean }) {
  const differsFromRequest = window.since !== logicalWindow.since || window.until !== logicalWindow.until;
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-[11px] text-muted-foreground">{formatWindow(window.since, window.until)}</p>{differsFromRequest && <p className="mt-1 text-[11px] text-status-warning">Rolling snapshot; requested {formatWindow(logicalWindow.since, logicalWindow.until)}</p>}{daily && observation ? <div className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1" aria-label={`${label} daily visitors`}>{observation.data.series.map((point) => <div key={point.date} className="flex justify-between gap-3 text-xs tabular-nums"><span className="text-muted-foreground">{formatDate(point.date)}</span><span>{point.value} {unit}</span></div>)}</div> : <p className="mt-2 text-2xl font-medium tabular-nums">{observation?.data.value ?? "—"} <span className="text-xs font-normal text-muted-foreground">{unit}</span></p>}</div>;
}
