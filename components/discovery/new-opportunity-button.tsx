"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePanelContext } from "@/components/panels/panel-context";
import { opportunityComposerId } from "@/lib/opportunity-draft";
import type { OpportunityStatus } from "@/lib/types";

type Props = {
  /**
   * `column`: the quiet "Add opportunity" row at the foot of a board column,
   * which presets that column's status. `rail`: the full "New Opportunity"
   * button at the foot of the discovery rail.
   */
  variant: "column" | "rail";
  status?: OpportunityStatus;
};

/**
 * Opens the "New opportunity" composer in the right-hand panel slot. On wide
 * viewports it docks beside the board (see PanelShell), so the board stays
 * usable while writing.
 */
export function NewOpportunityButton({ variant, status }: Props) {
  const { panel, openPanel } = usePanelContext();
  const id = opportunityComposerId(status);
  const composerOpen = panel?.type === "opportunity-new";

  const open = () => {
    // Already showing exactly this: leave the draft and the history alone.
    if (composerOpen && panel.id === id) return;
    // Switching columns while composing only changes the preset, and on
    // mobile the composer takes over the rail's own panel — replace both, so
    // Back does not step through panels the user has already left.
    openPanel("opportunity-new", id, { replace: composerOpen || panel?.type === "discovery-rail" });
  };

  if (variant === "column") {
    return (
      <button
        type="button"
        onClick={open}
        className="flex items-center gap-1.5 w-full rounded-lg px-2.5 py-2 text-xs font-medium text-text-subtle hover:text-primary hover:bg-surface-panel/70 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add opportunity
      </button>
    );
  }

  return (
    <Button type="button" onClick={open} aria-expanded={composerOpen}>
      <PlusIcon />
      New Opportunity
    </Button>
  );
}
