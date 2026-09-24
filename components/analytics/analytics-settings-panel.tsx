"use client";

import { useMemo, useState, useTransition } from "react";
import { ArchiveIcon, PencilIcon, PlusIcon, TriangleIcon } from "lucide-react";
import type { ConnectionDTO, MetricDTO, MetricInput } from "@/lib/analytics/service";
import { unwrapAnalyticsAction } from "@/lib/analytics/action-result";
import {
  archiveAnalyticsMetric,
  connectAnalytics,
  createAnalyticsMetric,
  disconnectAnalytics,
  editAnalyticsMetric,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Props = {
  orgSlug: string;
  workspaceSlug: string;
  initialConnections: ConnectionDTO[];
  initialMetrics: MetricDTO[];
  canManage: boolean;
};

type MetricKind = "pageviews" | "daily_visitors" | "event_count";

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known: Record<string, string> = {
    AUTHENTICATION: "Vercel rejected that access token.",
    ACCESS_DENIED: "That account cannot access this Vercel project.",
    PROJECT_NOT_FOUND: "Vercel could not find that project.",
    ANALYTICS_DISABLED: "Web Analytics is not enabled for that project.",
    PLAN_REQUIRED: "This query requires a Vercel plan with Web Analytics access.",
    PROJECT_IDENTITY_IMMUTABLE: "Disconnecting does not change project identity. Reconnect the same project or create a new workspace connection.",
    REVISION_CONFLICT: "This metric changed elsewhere. Reload before editing it again.",
    ENCRYPTION_NOT_CONFIGURED: "Analytics credential storage is not configured. Contact your Compass administrator.",
    INVALID_INPUT: "Check the metric or connection fields and try again.",
    RATE_LIMITED: "Vercel rate-limited this request. Try again later.",
    PROVIDER_UNAVAILABLE: "Vercel is temporarily unavailable. Try again later.",
  };
  return known[code] ?? "The analytics change could not be saved. Try again.";
}

function metricKind(metric?: MetricDTO): MetricKind {
  const value = metric?.query.metric;
  return value === "daily_visitors" || value === "event_count" ? value : "pageviews";
}

export function AnalyticsSettingsPanel({ orgSlug, workspaceSlug, initialConnections, initialMetrics, canManage }: Props) {
  const [connections, setConnections] = useState(initialConnections);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [metricOpen, setMetricOpen] = useState(false);
  const [editingMetric, setEditingMetric] = useState<MetricDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const vercel = connections.find((connection) => connection.provider === "vercel");
  const activeMetrics = useMemo(() => metrics.filter((metric) => !metric.archived), [metrics]);

  function openMetric(metric: MetricDTO | null) {
    setEditingMetric(metric);
    setError(null);
    setMetricOpen(true);
  }

  function saveConnection(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const saved = unwrapAnalyticsAction(await connectAnalytics(orgSlug, workspaceSlug, {
          projectId: String(formData.get("projectId") ?? ""),
          teamId: String(formData.get("teamId") ?? "").trim() || undefined,
          token: String(formData.get("token") ?? ""),
        }));
        setConnections((current) => [saved, ...current.filter((connection) => connection.provider !== "vercel")]);
        setConnectionOpen(false);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function disconnect() {
    if (!vercel) return;
    setError(null);
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await disconnectAnalytics(orgSlug, workspaceSlug, vercel.id));
        setConnections((current) => current.map((connection) => connection.id === vercel.id
          ? { ...connection, enabled: false, health: "DISCONNECTED", generation: connection.generation + 1 }
          : connection));
        setDisconnectOpen(false);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function saveMetric(formData: FormData) {
    if (!vercel?.enabled) return;
    const kind = String(formData.get("measure")) as MetricKind;
    const eventName = String(formData.get("eventName") ?? "").trim();
    const action = String(formData.get("action") ?? "").trim();
    const path = String(formData.get("path") ?? "").trim();
    const query: MetricInput["query"] = {
      metric: kind,
      ...(kind === "event_count" && eventName ? { eventName } : {}),
      ...(kind !== "event_count" && path ? { path } : {}),
      ...(kind === "event_count" && action ? { eventProperties: { action } } : {}),
    };
    const input: MetricInput = {
      name: String(formData.get("name") ?? ""),
      unit: String(formData.get("unit") ?? ""),
      provider: "vercel",
      connectionId: vercel.id,
      query,
    };
    setError(null);
    startTransition(async () => {
      try {
        const saved = unwrapAnalyticsAction(editingMetric
          ? await editAnalyticsMetric(orgSlug, workspaceSlug, editingMetric.id, { ...input, expectedRevision: editingMetric.revision })
          : await createAnalyticsMetric(orgSlug, workspaceSlug, input));
        setMetrics((current) => [saved, ...current.filter((metric) => metric.id !== saved.id)]);
        setMetricOpen(false);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  function archive(metric: MetricDTO) {
    setError(null);
    startTransition(async () => {
      try {
        unwrapAnalyticsAction(await archiveAnalyticsMetric(orgSlug, workspaceSlug, metric.id));
        setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, archived: true } : item));
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p role="alert" className="rounded-lg border border-status-danger/25 bg-status-danger-surface px-3 py-2 text-sm text-status-danger">{error}</p>}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-stretch gap-3 rounded-xl border border-border-default bg-surface-panel px-4 py-4 sm:flex-row sm:items-center">
          <div className="hidden size-9 shrink-0 place-items-center rounded-lg border border-border-default bg-surface-inset sm:grid"><TriangleIcon className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-text-primary">Vercel Web Analytics</p>
              <Badge variant={vercel?.enabled ? "secondary" : "outline"}>{vercel?.enabled ? "Connected" : "Disconnected"}</Badge>
            </div>
            <p className="mt-1 text-xs text-text-subtle">{vercel ? `${vercel.projectId} · Production` : "Connect one production project"}</p>
            <p className="mt-1 text-xs text-text-subtle">Credentials are encrypted and never displayed after saving.</p>
          </div>
          {canManage && (
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="outline" onClick={() => { setError(null); setConnectionOpen(true); }}>{vercel?.enabled ? "Manage" : "Connect Vercel"}</Button>
              {vercel?.enabled && <Button variant="destructive" onClick={() => setDisconnectOpen(true)}>Disconnect</Button>}
            </div>
          )}
        </div>
        <div className="flex flex-col items-stretch gap-3 rounded-xl border border-border-default bg-surface-panel px-4 py-4 sm:flex-row sm:items-center">
          <div className="hidden size-9 shrink-0 place-items-center rounded-lg border border-border-default bg-surface-inset sm:grid">◇</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><p className="font-medium text-text-primary">Compass activation</p><Badge variant="outline">Operator only</Badge></div>
            <p className="mt-1 text-xs text-text-subtle">Discovery + Delivery + Learning within a trailing 30-day window.</p>
            <p className="mt-1 text-xs text-text-subtle">Installation-wide aggregate; customer identities stay private.</p>
          </div>
          <Badge variant="secondary" className="self-end sm:self-auto">Built in</Badge>
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div><h3 className="font-semibold text-text-primary">Metrics</h3><p className="mt-1 text-sm text-text-subtle">Define once. Reuse across experiments, launches, and key results.</p></div>
          {canManage && <Button onClick={() => openMetric(null)} disabled={!vercel?.enabled}><PlusIcon />Create metric</Button>}
        </div>
        <div className="overflow-hidden rounded-xl border border-border-default bg-surface-panel">
          {activeMetrics.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-subtle">No metrics defined yet. Connect Vercel, then create a reusable measurement.</p>
          ) : activeMetrics.map((metric, index) => (
            <div key={metric.id} className={`flex items-center gap-3 px-4 py-4 ${index ? "border-t border-border-default" : ""}`}>
              <div className="min-w-0 flex-1"><p className="font-medium text-text-primary">{metric.name}</p><p className="mt-1 text-xs text-text-subtle">{metric.provider === "vercel" ? "Vercel" : "Compass"} · {metric.query.metric.replaceAll("_", " ")} · Revision {metric.revision}</p></div>
              <Badge variant="outline">{metric.unit}</Badge>
              {canManage && <>{metric.provider === "vercel" && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${metric.name}`} onClick={() => openMetric(metric)} disabled={!vercel?.enabled}><PencilIcon /></Button>}<Button size="icon-sm" variant="ghost" aria-label={`Archive ${metric.name}`} onClick={() => archive(metric)}><ArchiveIcon /></Button></>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-text-subtle">Editing creates a new revision. Existing measurements keep the definition they were linked to.</p>
      </div>

      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent>
          <form action={saveConnection} className="contents">
            <DialogHeader><DialogTitle>Vercel connection</DialogTitle><DialogDescription>Access is validated before credentials are saved.</DialogDescription></DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="grid gap-1.5"><Label htmlFor="analytics-project-id">Project ID</Label><Input id="analytics-project-id" name="projectId" required defaultValue={vercel?.projectId ?? ""} readOnly={Boolean(vercel)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="analytics-team-id">Team ID (optional)</Label><Input id="analytics-team-id" name="teamId" defaultValue={vercel?.teamId ?? ""} readOnly={Boolean(vercel)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="analytics-token">Access token</Label><Input id="analytics-token" name="token" type="password" autoComplete="off" required placeholder="Never displayed after saving" /></div>
            </div>
            {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
            <DialogFooter><Button type="submit" disabled={isPending}>{isPending ? "Validating…" : "Validate & save"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {metricOpen && <MetricDialog open onOpenChange={setMetricOpen} metric={editingMetric} pending={isPending} error={error} onSubmit={saveMetric} />}

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Disconnect Vercel?</AlertDialogTitle><AlertDialogDescription>Credentials will be removed. Existing observations remain available as evidence.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={disconnect} disabled={isPending}>Disconnect</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MetricDialog({ open, onOpenChange, metric, pending, error, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; metric: MetricDTO | null; pending: boolean; error: string | null; onSubmit: (formData: FormData) => void }) {
  const [kind, setKind] = useState<MetricKind>(metricKind(metric ?? undefined));
  const key = metric ? `${metric.id}:${metric.revision}` : "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={key} className="sm:max-w-md">
        <form action={onSubmit} className="contents">
          <DialogHeader><DialogTitle>{metric ? "Edit metric" : "Create metric"}</DialogTitle><DialogDescription>Only allowlisted aggregate fields are sent to the provider.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5"><Label htmlFor={`metric-name-${key}`}>Name</Label><Input id={`metric-name-${key}`} name="name" required defaultValue={metric?.name ?? ""} /></div>
            <div className="grid gap-1.5"><Label htmlFor={`metric-unit-${key}`}>Unit</Label><Input id={`metric-unit-${key}`} name="unit" required defaultValue={metric?.unit ?? "views"} /></div>
            <div className="grid gap-1.5"><Label htmlFor={`metric-measure-${key}`}>Measure</Label><select id={`metric-measure-${key}`} name="measure" value={kind} onChange={(event) => setKind(event.target.value as MetricKind)} className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"><option value="pageviews">Pageviews</option><option value="daily_visitors">Daily visitors</option><option value="event_count">Custom event count</option></select></div>
            {kind === "event_count" ? <><div className="grid gap-1.5"><Label htmlFor={`metric-event-${key}`}>Event name</Label><Input id={`metric-event-${key}`} name="eventName" required defaultValue={metric?.query.eventName ?? ""} /></div><div className="grid gap-1.5"><Label htmlFor={`metric-action-${key}`}>Action filter (optional)</Label><Input id={`metric-action-${key}`} name="action" defaultValue={metric?.query.eventProperties?.action ?? ""} /></div></> : <div className="grid gap-1.5"><Label htmlFor={`metric-path-${key}`}>Path filter (optional)</Label><Input id={`metric-path-${key}`} name="path" placeholder="/roadmap" defaultValue={metric?.query.path ?? ""} /></div>}
            <p className="text-xs leading-5 text-text-subtle">No user identifiers or free-text product content are supported.</p>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save metric"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
