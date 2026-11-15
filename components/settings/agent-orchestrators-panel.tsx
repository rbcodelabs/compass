"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { updatePersonalOrchestratorConfig } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { PersonalOrchestratorSettingsData } from "@/lib/orchestrator/wakeups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialSettings: PersonalOrchestratorSettingsData;
}

export function AgentOrchestratorsPanel({
  orgSlug,
  workspaceSlug,
  initialSettings,
}: Props) {
  const [wsConfig, setWsConfig] = useState(initialSettings.workspaceOrchestrator);
  const [wsSaved, setWsSaved] = useState(initialSettings.workspaceOrchestrator);
  const [wsNotice, setWsNotice] = useState<string | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [isWsPending, startWsTransition] = useTransition();

  const [squadConfigs, setSquadConfigs] = useState(initialSettings.squadOrchestrators);
  const [squadSaved, setSquadSaved] = useState(initialSettings.squadOrchestrators);
  const [squadNotices, setSquadNotices] = useState<Record<string, string | null>>({});
  const [squadErrors, setSquadErrors] = useState<Record<string, string | null>>({});
  const [pendingSquadId, setPendingSquadId] = useState<string | null>(null);
  const [, startSquadTransition] = useTransition();

  const wsDirty =
    wsConfig.enabled !== wsSaved.enabled ||
    wsConfig.wakeOnActivity !== wsSaved.wakeOnActivity ||
    wsConfig.heartbeatEnabled !== wsSaved.heartbeatEnabled ||
    wsConfig.heartbeatMinutes !== wsSaved.heartbeatMinutes;

  function handleSaveWorkspace() {
    setWsNotice(null);
    setWsError(null);
    startWsTransition(async () => {
      try {
        const res = await updatePersonalOrchestratorConfig(orgSlug, workspaceSlug, {
          scopeType: "WORKSPACE",
          enabled: wsConfig.enabled,
          wakeOnActivity: wsConfig.wakeOnActivity,
          heartbeatEnabled: wsConfig.heartbeatEnabled,
          heartbeatMinutes: wsConfig.heartbeatMinutes,
        });
        const next = {
          ...wsConfig,
          id: res.id,
          conversationId: res.conversationId,
          enabled: res.enabled,
          wakeOnActivity: res.wakeOnActivity,
          heartbeatEnabled: res.heartbeatEnabled,
          heartbeatMinutes: res.heartbeatMinutes,
        };
        setWsConfig(next);
        setWsSaved(next);
        setWsNotice(
          res.enabled
            ? "Saved. Your personal Workspace Orchestrator is active."
            : "Saved. Your personal Workspace Orchestrator is paused."
        );
      } catch (err) {
        setWsError(err instanceof Error ? err.message : "Could not save Workspace Orchestrator");
      }
    });
  }

  function handleSaveSquad(squadId: string) {
    const current = squadConfigs.find((s) => s.squadId === squadId);
    if (!current) return;
    setSquadNotices((prev) => ({ ...prev, [squadId]: null }));
    setSquadErrors((prev) => ({ ...prev, [squadId]: null }));
    setPendingSquadId(squadId);
    startSquadTransition(async () => {
      try {
        const res = await updatePersonalOrchestratorConfig(orgSlug, workspaceSlug, {
          scopeType: "SQUAD",
          squadId,
          enabled: current.enabled,
          wakeOnActivity: current.wakeOnActivity,
          heartbeatEnabled: current.heartbeatEnabled,
          heartbeatMinutes: current.heartbeatMinutes,
          escalationsEnabled: current.escalationsEnabled,
        });
        const updated = {
          ...current,
          id: res.id,
          conversationId: res.conversationId,
          enabled: res.enabled,
          wakeOnActivity: res.wakeOnActivity,
          heartbeatEnabled: res.heartbeatEnabled,
          heartbeatMinutes: res.heartbeatMinutes,
          escalationsEnabled: res.escalationsEnabled,
        };
        setSquadConfigs((prev) => prev.map((s) => (s.squadId === squadId ? updated : s)));
        setSquadSaved((prev) => prev.map((s) => (s.squadId === squadId ? updated : s)));
        setSquadNotices((prev) => ({
          ...prev,
          [squadId]: res.enabled
            ? `Saved. ${current.squadName} Orchestrator is active.`
            : `Saved. ${current.squadName} Orchestrator is paused.`,
        }));
      } catch (err) {
        setSquadErrors((prev) => ({
          ...prev,
          [squadId]: err instanceof Error ? err.message : "Could not save Squad Orchestrator",
        }));
      } finally {
        setPendingSquadId(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="agent-orchestrators-panel">
      {/* Workspace Orchestrator */}
      <div
        className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
        data-testid="workspace-orchestrator-settings-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Workspace Orchestrator</span>
            <Badge variant={wsSaved.enabled ? "default" : "secondary"}>
              {wsSaved.enabled ? "Enabled" : "Off"}
            </Badge>
          </div>
          {wsConfig.conversationId && (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/${orgSlug}/${workspaceSlug}/agent?c=${wsConfig.conversationId}`}
                  data-testid="workspace-orchestrator-open-thread"
                />
              }
            >
              Open thread
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Your personal portfolio supervisor for unassigned agent threads and cross-Squad rollups. Stages human-gated proposed replies and structured decisions without messaging threads behind your back.
        </p>

        <div className="flex flex-col gap-2.5 pt-1">
          <label
            className="flex items-start gap-2 text-sm"
            htmlFor="workspace-orchestrator-enabled"
          >
            <Checkbox
              id="workspace-orchestrator-enabled"
              data-testid="workspace-orchestrator-enabled"
              className="mt-0.5"
              checked={wsConfig.enabled}
              disabled={isWsPending}
              onCheckedChange={(checked) =>
                setWsConfig((prev) => ({ ...prev, enabled: Boolean(checked) }))
              }
            />
            <span>
              <span className="font-medium">Enable Workspace Orchestrator</span>{" "}
              <span className="text-xs text-muted-foreground">
                — provisions your personal Workspace Orchestrator thread and floating dock.
              </span>
            </span>
          </label>

          <label
            className="flex items-start gap-2 text-sm"
            htmlFor="workspace-orchestrator-wake-on-activity"
          >
            <Checkbox
              id="workspace-orchestrator-wake-on-activity"
              data-testid="workspace-orchestrator-wake-on-activity"
              className="mt-0.5"
              checked={wsConfig.wakeOnActivity}
              disabled={isWsPending || !wsConfig.enabled}
              onCheckedChange={(checked) =>
                setWsConfig((prev) => ({ ...prev, wakeOnActivity: Boolean(checked) }))
              }
            />
            <span>
              <span className="font-medium">Wake on thread activity</span>{" "}
              <span className="text-xs text-muted-foreground">
                — coalesces completed turns across a 60s quiet wait (0s on errors) and 12s batch window.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="workspace-orchestrator-heartbeat-enabled"
            >
              <Checkbox
                id="workspace-orchestrator-heartbeat-enabled"
                data-testid="workspace-orchestrator-heartbeat-enabled"
                checked={wsConfig.heartbeatEnabled}
                disabled={isWsPending || !wsConfig.enabled}
                onCheckedChange={(checked) =>
                  setWsConfig((prev) => ({ ...prev, heartbeatEnabled: Boolean(checked) }))
                }
              />
              <span className="font-medium">Activity-gated heartbeat</span>
            </label>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>every</span>
              <Input
                type="number"
                min={5}
                max={1440}
                value={wsConfig.heartbeatMinutes}
                disabled={isWsPending || !wsConfig.enabled || !wsConfig.heartbeatEnabled}
                data-testid="workspace-orchestrator-heartbeat-minutes"
                className="h-7 w-20 text-xs"
                onChange={(e) =>
                  setWsConfig((prev) => ({
                    ...prev,
                    heartbeatMinutes: Math.max(5, Math.min(1440, Number(e.target.value) || 60)),
                  }))
                }
              />
              <span>minutes (skips when idle)</span>
            </div>
          </div>
        </div>

        {wsNotice && (
          <p
            role="status"
            data-testid="workspace-orchestrator-notice"
            className="text-xs text-status-success"
          >
            {wsNotice}
          </p>
        )}
        {wsError && (
          <p role="alert" className="text-xs text-destructive">
            {wsError}
          </p>
        )}

        <div>
          <Button
            size="sm"
            onClick={handleSaveWorkspace}
            disabled={isWsPending || !wsDirty}
            data-testid="workspace-orchestrator-save"
          >
            {isWsPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Per-Squad Orchestrators */}
      {squadConfigs.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs font-medium text-muted-foreground">
            Per-Squad Orchestrators (auto-created on first completed Squad run unless disabled)
          </div>
          {squadConfigs.map((sq) => {
            const saved = squadSaved.find((s) => s.squadId === sq.squadId) ?? sq;
            const dirty =
              sq.enabled !== saved.enabled ||
              sq.wakeOnActivity !== saved.wakeOnActivity ||
              sq.heartbeatEnabled !== saved.heartbeatEnabled ||
              sq.heartbeatMinutes !== saved.heartbeatMinutes ||
              sq.escalationsEnabled !== saved.escalationsEnabled;
            const isSaving = pendingSquadId === sq.squadId;

            return (
              <div
                key={sq.squadId}
                className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3"
                data-testid={`squad-orchestrator-settings-card-${sq.squadId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {sq.squadName} Orchestrator
                    </span>
                    <Badge variant={saved.enabled ? "default" : "secondary"}>
                      {saved.enabled ? "Enabled" : "Auto on activity"}
                    </Badge>
                  </div>
                  {sq.conversationId && (
                    <Button
                      variant="outline"
                      size="sm"
                      render={
                        <Link
                          href={`/${orgSlug}/${workspaceSlug}/agent?c=${sq.conversationId}`}
                          data-testid={`squad-orchestrator-open-thread-${sq.squadId}`}
                        />
                      }
                    >
                      Open thread
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <label
                    className="flex items-center gap-2"
                    htmlFor={`squad-orch-enabled-${sq.squadId}`}
                  >
                    <Checkbox
                      id={`squad-orch-enabled-${sq.squadId}`}
                      data-testid={`squad-orchestrator-enabled-${sq.squadId}`}
                      checked={sq.enabled}
                      disabled={isSaving}
                      onCheckedChange={(checked) =>
                        setSquadConfigs((prev) =>
                          prev.map((item) =>
                            item.squadId === sq.squadId
                              ? { ...item, enabled: Boolean(checked) }
                              : item
                          )
                        )
                      }
                    />
                    <span className="font-medium text-foreground">Enabled</span>
                  </label>

                  <label
                    className="flex items-center gap-2"
                    htmlFor={`squad-orch-wake-${sq.squadId}`}
                  >
                    <Checkbox
                      id={`squad-orch-wake-${sq.squadId}`}
                      data-testid={`squad-orchestrator-wake-on-activity-${sq.squadId}`}
                      checked={sq.wakeOnActivity}
                      disabled={isSaving}
                      onCheckedChange={(checked) =>
                        setSquadConfigs((prev) =>
                          prev.map((item) =>
                            item.squadId === sq.squadId
                              ? { ...item, wakeOnActivity: Boolean(checked) }
                              : item
                          )
                        )
                      }
                    />
                    <span className="text-muted-foreground">Wake on Squad activity</span>
                  </label>

                  <label
                    className="flex items-center gap-2"
                    htmlFor={`squad-orch-escalations-${sq.squadId}`}
                  >
                    <Checkbox
                      id={`squad-orch-escalations-${sq.squadId}`}
                      data-testid={`squad-orchestrator-escalations-${sq.squadId}`}
                      checked={sq.escalationsEnabled}
                      disabled={isSaving}
                      onCheckedChange={(checked) =>
                        setSquadConfigs((prev) =>
                          prev.map((item) =>
                            item.squadId === sq.squadId
                              ? { ...item, escalationsEnabled: Boolean(checked) }
                              : item
                          )
                        )
                      }
                    />
                    <span className="text-muted-foreground">
                      Allow escalations to Workspace Orchestrator
                    </span>
                  </label>
                </div>

                {squadNotices[sq.squadId] && (
                  <p
                    role="status"
                    data-testid={`squad-orchestrator-notice-${sq.squadId}`}
                    className="text-xs text-status-success"
                  >
                    {squadNotices[sq.squadId]}
                  </p>
                )}
                {squadErrors[sq.squadId] && (
                  <p role="alert" className="text-xs text-destructive">
                    {squadErrors[sq.squadId]}
                  </p>
                )}

                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleSaveSquad(sq.squadId)}
                    disabled={isSaving || !dirty}
                    data-testid={`squad-orchestrator-save-${sq.squadId}`}
                  >
                    {isSaving ? "Saving…" : "Save Squad settings"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
