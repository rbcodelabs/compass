"use client";

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Chrome shared by the two docked "Not scheduled" panes: the board's sidebar and the timeline's
 * rail. Both dock on the right of the chart, use the same title and count styling, collapse from
 * a button in their own header, and fold down to the same thin tab. Keeping the pieces here is
 * what stops the two views drifting apart again; the contents (cards, search, bulk scheduling)
 * stay with each view.
 */

export const NOT_SCHEDULED_TITLE = "Not scheduled";

/** Tailwind needs these as literal strings. 18rem is `w-72`, the width the board's columns use. */
export const SIDEBAR_WIDTH_CLASS = "w-72";

const COLLAPSE_BUTTON_CLASS =
  "inline-flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-panel hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SidebarCollapseButton({ onClick, controls }: { onClick: () => void; controls?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Collapse ${NOT_SCHEDULED_TITLE}`}
      aria-controls={controls}
      data-testid="sidebar-collapse"
      className={COLLAPSE_BUTTON_CLASS}
    >
      <PanelRightClose aria-hidden className="size-4" />
    </button>
  );
}

/** Title, count pill and collapse action, styled like a board column header. */
export function SidebarTitleRow({ count, countTestId, action }: { count: number; countTestId?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-4 w-1 rounded-full bg-status-neutral" />
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{NOT_SCHEDULED_TITLE}</h3>
      <span
        data-testid={countTestId}
        aria-label={`${count} items`}
        className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs tabular-nums text-text-subtle"
      >
        {count}
      </span>
      {action}
    </div>
  );
}

/** The thin tab a collapsed pane leaves behind; clicking it expands the pane again. */
export function CollapsedSidebarTab({ count, onClick, controls, className }: { count: number; onClick: () => void; controls?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Expand ${NOT_SCHEDULED_TITLE} (${count})`}
      aria-expanded={false}
      aria-controls={controls}
      data-testid="sidebar-collapsed-tab"
      className={cn(
        "flex h-fit w-10 shrink-0 flex-col items-center gap-2 rounded-xl border border-border-default bg-surface-inset py-3 text-text-subtle hover:bg-surface-panel hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <PanelRightOpen aria-hidden className="size-4" />
      <span className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs tabular-nums">{count}</span>
      <span className="text-xs font-semibold [writing-mode:vertical-rl]">{NOT_SCHEDULED_TITLE}</span>
    </button>
  );
}
