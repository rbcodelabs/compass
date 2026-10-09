"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkspaceCreateButton } from "@/components/patterns/workspace-header-controls";
import { FEEDBACK_COMPOSER_ID, usePanelContext } from "@/components/panels/panel-context";

type Props = {
  /** `empty-state` renders a call-to-action styled trigger for the board's empty state instead of the header's create button. */
  variant?: "toolbar" | "empty-state";
};

/**
 * Opens the "New feedback" composer in the right-hand panel slot. The board
 * stays on screen: on wide viewports the composer docks beside it, and on
 * narrow ones it falls back to a full-width sheet — see PanelShell.
 */
export function NewFeedbackButton({ variant = "toolbar" }: Props) {
  const { panel, openPanel } = usePanelContext();
  const open = panel?.type === "feedback-new";

  const openComposer = () => {
    // Already open: leave the draft and the history entry alone.
    if (!open) openPanel("feedback-new", FEEDBACK_COMPOSER_ID);
  };

  if (variant === "empty-state") {
    return (
      <Button type="button" aria-expanded={open} className="w-fit" onClick={openComposer}>
        <PlusIcon />
        New Feedback
      </Button>
    );
  }

  return <WorkspaceCreateButton label="New Feedback" aria-expanded={open} onClick={openComposer} />;
}
