"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/patterns/confirm-dialog"
import { SettingsSection } from "@/components/patterns/settings-section"

export type AgentSnapshotStatusView = {
  goldenSnapshotId: string | null
  depsFingerprint: string | null
  snapshotBuiltAt: string | null
  currentDepsFingerprint: string
  stale: boolean
}

type RebuildResult = {
  ok: boolean
  error?: string
  snapshotId?: string
  depsFingerprint?: string
  sizeBytes?: number
  timings?: { createMs: number; installMs: number; snapshotMs: number; totalMs: number }
  log?: string[]
  previousSnapshotId?: string | null
  deletedPreviousSnapshot?: boolean
  previousSnapshotDeleteError?: string
}

const ENDPOINT = "/api/admin/agent-snapshot"

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-text-subtle">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-sm text-text-primary">{value}</dd>
    </div>
  )
}

export function AgentSnapshotPanel({ initialStatus }: { initialStatus: AgentSnapshotStatusView }) {
  const [status, setStatus] = useState(initialStatus)
  const [result, setResult] = useState<RebuildResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function refreshStatus() {
    const response = await fetch(ENDPOINT, { cache: "no-store" })
    if (response.ok) setStatus(await response.json())
  }

  function rebuild() {
    setError(null)
    setResult(null)
    startTransition(async () => {
      try {
        const response = await fetch(ENDPOINT, { method: "POST" })
        const text = await response.text()
        let body: RebuildResult | null = null
        try {
          body = JSON.parse(text) as RebuildResult
        } catch {
          // Non-JSON (401/403 text, or a platform timeout page).
        }
        if (body) setResult(body)
        else setError(text || `Rebuild failed (${response.status})`)
        await refreshStatus()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Rebuild failed")
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Current snapshot"
        description={
          status.stale
            ? "Stale: no snapshot has been built, or it was built from a different dependency set than this deployment. Rebuild it."
            : "Current: the stored snapshot matches this deployment's dependency set."
        }
        actions={
          <span
            className={
              status.stale
                ? "rounded-full border border-status-warning/40 bg-status-warning-surface px-2 py-0.5 text-xs font-medium text-status-warning"
                : "rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-status-success"
            }
          >
            {status.stale ? "Stale" : "Current"}
          </span>
        }
      >
        <dl className="grid gap-4 sm:grid-cols-2">
          <Field label="Snapshot id" value={status.goldenSnapshotId ?? "None"} />
          <Field label="Built at" value={status.snapshotBuiltAt ?? "Never"} />
          <Field label="Stored fingerprint" value={status.depsFingerprint ?? "None"} />
          <Field label="Current fingerprint" value={status.currentDepsFingerprint} />
        </dl>
      </SettingsSection>

      <SettingsSection
        title="Rebuild"
        description="Builds a fresh snapshot, makes it the golden one, and only then deletes the one it replaces."
      >
        <div className="flex flex-col gap-3">
          <div>
            <ConfirmDialog
              trigger={<Button disabled={pending}>{pending ? "Rebuilding..." : "Rebuild snapshot"}</Button>}
              title="Rebuild the agent snapshot?"
              description="This creates a new sandbox, installs dependencies and a headless browser, and replaces the golden snapshot. It takes several minutes."
              confirmLabel="Rebuild"
              onConfirm={rebuild}
            />
          </div>
          {pending && (
            <p role="status" className="text-sm text-text-subtle">
              Rebuilding. This takes several minutes; keep this page open until it finishes.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          {result && !result.ok && (
            <p role="alert" className="text-sm text-status-danger">
              Rebuild failed: {result.error}
            </p>
          )}
          {result?.ok && (
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm text-status-success">Rebuild succeeded.</p>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="New snapshot id" value={result.snapshotId ?? ""} />
                <Field
                  label="Previous snapshot"
                  value={
                    result.previousSnapshotId
                      ? `${result.previousSnapshotId} (${result.deletedPreviousSnapshot ? "deleted" : "not deleted"})`
                      : "None"
                  }
                />
                {result.timings && (
                  <Field
                    label="Timings"
                    value={`total ${seconds(result.timings.totalMs)} (create ${seconds(result.timings.createMs)}, install ${seconds(result.timings.installMs)}, snapshot ${seconds(result.timings.snapshotMs)})`}
                  />
                )}
              </dl>
              {result.previousSnapshotDeleteError && (
                <p role="alert" className="text-sm text-status-warning">
                  Warning: the previous snapshot could not be deleted and may still consume storage:{" "}
                  {result.previousSnapshotDeleteError}
                </p>
              )}
            </div>
          )}
          {result?.log && result.log.length > 0 && (
            <pre className="max-h-80 overflow-auto rounded-lg border border-border-default bg-surface-app p-3 text-xs">
              {result.log.join("\n")}
            </pre>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}
