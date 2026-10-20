"use client";

import { Redo2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/** What the toolbar (or the grid's own fallback row) needs to draw undo / redo. */
export type GridHistoryControl = {
  canUndo: boolean;
  canRedo: boolean;
  /** A revert is in flight; both buttons wait so two cannot interleave. */
  busy: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

/**
 * Undo / redo buttons for sheet mode. The keyboard shortcuts (Ctrl/Cmd+Z,
 * Shift+Ctrl/Cmd+Z, Ctrl+Y) work on the focused cell; these exist so the
 * feature is discoverable and reachable without them.
 */
export function GridHistoryControls({ history }: { history: GridHistoryControl }) {
  return (
    <div role="group" aria-label="History" className="flex items-center gap-1" data-testid="grid-history">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        aria-keyshortcuts="Control+Z Meta+Z"
        disabled={!history.canUndo || history.busy}
        onClick={history.onUndo}
        data-testid="grid-undo"
      >
        <Undo2 />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z"
        disabled={!history.canRedo || history.busy}
        onClick={history.onRedo}
        data-testid="grid-redo"
      >
        <Redo2 />
      </Button>
    </div>
  );
}
