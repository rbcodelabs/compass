"use client";

import { useEffect, useRef } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePanelContext } from "@/components/panels/panel-context";
import { experimentComposerId } from "@/lib/experiment-draft";

type Props = {
  /**
   * The "Test this assumption" CTA links here with `?assumptionId=…`. When
   * present, the composer opens on arrival with that assumption selected.
   */
  prefillAssumptionId?: string | null;
};

/**
 * Opens the "New experiment" composer in the right-hand panel slot. On wide
 * viewports it docks beside the board (see PanelShell), so the board stays
 * usable while writing.
 */
export function NewExperimentButton({ prefillAssumptionId = null }: Props) {
  const { panel, openPanel } = usePanelContext();
  const open = panel?.type === "experiment-new";
  const autoOpened = useRef(false);

  useEffect(() => {
    if (!prefillAssumptionId || autoOpened.current) return;
    autoOpened.current = true;
    openPanel("experiment-new", experimentComposerId(prefillAssumptionId), { replace: true });
    // Mount-only: re-running on every panel change would reopen a closed composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label="New Experiment"
      aria-expanded={open}
      className="size-8 w-fit p-0 sm:h-8 sm:px-3"
      onClick={() => {
        // Already open: leave the draft and the history entry alone.
        if (!open) openPanel("experiment-new", experimentComposerId());
      }}
    >
      <PlusIcon />
      <span className="hidden sm:inline">New Experiment</span>
    </Button>
  );
}
