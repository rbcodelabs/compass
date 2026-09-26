"use client";

import { useState, useTransition } from "react";
import { TriangleIcon } from "lucide-react";
import type { ConnectionDTO } from "@/lib/analytics/service";
import { unwrapAnalyticsAction } from "@/lib/analytics/action-result";
import {
  connectAnalytics,
  disconnectAnalytics,
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
  canManage: boolean;
};

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known: Record<string, string> = {
    AUTHENTICATION: "Vercel rejected that access token.",
    ACCESS_DENIED: "That account cannot access this Vercel project.",
    PROJECT_NOT_FOUND: "Vercel could not find that project.",
    ANALYTICS_DISABLED: "Web Analytics is not enabled for that project.",
    PLAN_REQUIRED: "This query requires a Vercel plan with Web Analytics access.",
    PROJECT_IDENTITY_IMMUTABLE: "Disconnecting does not change project identity. Reconnect the same project or create a new workspace connection.",
    ENCRYPTION_NOT_CONFIGURED: "Analytics credential storage is not configured. Contact your Compass administrator.",
    INVALID_INPUT: "Check the connection fields and try again.",
    RATE_LIMITED: "Vercel rate-limited this request. Try again later.",
    PROVIDER_UNAVAILABLE: "Vercel is temporarily unavailable. Try again later.",
  };
  return known[code] ?? "The analytics change could not be saved. Try again.";
}

/**
 * Connection management only. Metric create/edit/archive live on the
 * standalone Metrics page (app/[orgSlug]/[workspaceSlug]/metrics) — see
 * components/analytics/metrics-dashboard.tsx.
 */
export function AnalyticsSettingsPanel({ orgSlug, workspaceSlug, initialConnections, canManage }: Props) {
  const [connections, setConnections] = useState(initialConnections);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const vercel = connections.find((connection) => connection.provider === "vercel");

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

      <p className="text-sm text-text-subtle">
        Metrics defined on this connection are managed from the{" "}
        <a href={`/${orgSlug}/${workspaceSlug}/metrics`} className="font-medium text-primary underline underline-offset-2">Metrics</a>{" "}
        page, alongside every metric&apos;s dashboard widget.
      </p>

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

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Disconnect Vercel?</AlertDialogTitle><AlertDialogDescription>Credentials will be removed. Existing observations remain available as evidence.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={disconnect} disabled={isPending}>Disconnect</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
