"use client"

import { useState, useTransition } from "react"
import { reconnectOAuthConnection, revokeOAuthConnection } from "@/app/settings/agents/actions"
import type { ConnectedApp } from "@/lib/oauth/connected-apps"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/patterns/settings-section"

function accessLabel(access: ConnectedApp["workspaces"][number]["access"]): string {
  if (access === "WRITE") return "Read and write"
  if (access === "FULL") return "Full account access"
  return "Read only"
}

function dateLabel(date: Date | null): string {
  return date
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "Never"
}

export function ConnectedAppsPanel({ connections: initialConnections }: { connections: ConnectedApp[] }) {
  const [connections, setConnections] = useState(initialConnections)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  function run(connection: ConnectedApp, reconnect: boolean) {
    setError(null)
    setStatus(null)
    startTransition(async () => {
      try {
        if (reconnect) await reconnectOAuthConnection(connection.id)
        else await revokeOAuthConnection(connection.id)
        setConnections((current) => current.filter((item) => item.id !== connection.id))
        if (reconnect) {
          setStatus(`Reconnect ${connection.clientName} from the app to choose a different authorization binding.`)
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not update the connection")
      }
    })
  }

  return (
    <SettingsSection
      title="Connected apps"
      description="OAuth apps connected to your account. Reconnect to choose a different agent or full-account binding."
    >
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        {status && <p role="status" className="text-sm text-text-subtle">{status}</p>}
        {connections.length === 0 && <p className="text-sm text-text-muted">No connected apps.</p>}
        {connections.map((connection) => (
          <article key={connection.id} className="space-y-3 rounded-lg border border-border-default p-4">
            <div>
              <h3 className="font-medium text-text-primary">{connection.clientName}</h3>
              <p className="text-xs text-text-muted">{connection.redirectHosts.join(", ")}</p>
            </div>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-text-muted">Authorization</dt>
              <dd>{connection.binding.mode === "AGENT" ? connection.binding.agentName : "Explicit full-account USER override"}</dd>
              <dt className="text-text-muted">Scopes</dt>
              <dd>{connection.scopes.join(", ") || "None"}</dd>
              <dt className="text-text-muted">Workspace access</dt>
              <dd>
                {connection.workspaces.length === 0 ? (
                  <span>No effective workspace access</span>
                ) : (
                  <ul className="space-y-1">
                    {connection.workspaces.map((workspace) => (
                      <li key={`${workspace.organizationName}-${workspace.workspaceName}`}>
                        {workspace.organizationName} · {workspace.workspaceName} · {accessLabel(workspace.access)}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="text-text-muted">Last used</dt>
              <dd>{dateLabel(connection.lastUsedAt)}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Reconnect ${connection.clientName} as a different agent`}
                onClick={() => run(connection, true)}
              >
                Reconnect as a different agent
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={pending}
                aria-label={`Revoke ${connection.clientName}`}
                onClick={() => run(connection, false)}
              >
                Revoke
              </Button>
            </div>
          </article>
        ))}
      </div>
    </SettingsSection>
  )
}
