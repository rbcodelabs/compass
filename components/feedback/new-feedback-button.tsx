"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FEEDBACK_COMPOSER_ID, usePanelContext } from "@/components/panels/panel-context";
import { cn } from "@/lib/utils";

type Props = {
  /** Renders a call-to-action styled trigger for the board's empty state instead of the compact toolbar trigger. */
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

  return (
    <Button
      type="button"
      variant={variant === "empty-state" ? "default" : "outline"}
      size="sm"
      aria-label={variant === "toolbar" ? "New Feedback" : undefined}
      aria-expanded={open}
      className={cn(
        "w-fit",
        variant === "toolbar" && "size-8 p-0 sm:h-8 sm:w-fit sm:px-3",
      )}
      onClick={() => {
        // Already open: leave the draft and the history entry alone.
        if (!open) openPanel("feedback-new", FEEDBACK_COMPOSER_ID);
      }}
    >
      <PlusIcon />
      <span className={cn(variant === "toolbar" && "hidden sm:inline")}>
        New Feedback
      </span>
    </Button>
  );
}
