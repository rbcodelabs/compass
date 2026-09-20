"use client";

import { useState, useTransition } from "react";
import { updateLaunchWorkflowSettings } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Switch } from "@/components/ui/switch";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  launchWorkflowEnabled: boolean;
}

/**
 * Gates the entire marketing-launch surface (launch tiers/checklists, the
 * LAUNCHING/LAUNCHED roadmap horizons, the roadmap-item panel's Launch
 * section, the roadmap card's launch chip/menu item, positioning briefs, and
 * the related MCP tools). Default off — most workspaces don't run a
 * marketing-launch workflow and found the always-on surface noisy. See
 * Compass solution 8303c3df-498d-4503-b92b-c7fd7a0fa62d.
 */
export function LaunchWorkflowSettingsPanel({ orgSlug, workspaceSlug, launchWorkflowEnabled: initial }: Props) {
  const [launchWorkflowEnabled, setLaunchWorkflowEnabled] = useState(initial);
  const [isPending, startTransition] = useTransition();

  function handleToggle(value: boolean) {
    setLaunchWorkflowEnabled(value);
    startTransition(async () => {
      await updateLaunchWorkflowSettings(orgSlug, workspaceSlug, { launchWorkflowEnabled: value });
    });
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Marketing launch workflow</span>
        <span className="text-xs text-muted-foreground">
          Adds launch tiers &amp; checklists, LAUNCHING/LAUNCHED roadmap stages, and
          positioning briefs. Off by default — turn on only if this workspace runs a
          formal marketing-launch process.
        </span>
      </div>
      <Switch
        data-testid="launch-workflow-toggle"
        aria-label="Marketing launch workflow"
        checked={launchWorkflowEnabled}
        disabled={isPending}
        onCheckedChange={handleToggle}
      />
    </div>
  );
}
