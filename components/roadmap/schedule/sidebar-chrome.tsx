"use client";

import { CollapsedColumnTab, ColumnCollapseButton } from "@/components/patterns/board-pinned";

/**
 * "Not scheduled" chrome for the timeline's rail. The collapse button and thin tab are the generic
 * pinned-column pieces from components/patterns/board-pinned.tsx (the board's "Not scheduled" column
 * uses them directly, as an ordinary pinned column), pre-titled here so the two views keep looking
 * alike; the contents (cards, search, bulk scheduling) stay with each view.
 */

export const NOT_SCHEDULED_TITLE = "Not scheduled";

/** Tailwind needs these as literal strings. 18rem is `w-72`, the width the board's columns use. */
export const SIDEBAR_WIDTH_CLASS = "w-72";

export function SidebarCollapseButton({ onClick, controls }: { onClick: () => void; controls?: string }) {
  return <ColumnCollapseButton title={NOT_SCHEDULED_TITLE} onClick={onClick} controls={controls} testId="sidebar-collapse" />;
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
    <CollapsedColumnTab
      title={NOT_SCHEDULED_TITLE}
      count={count}
      onClick={onClick}
      controls={controls}
      className={className}
      testId="sidebar-collapsed-tab"
    />
  );
}
