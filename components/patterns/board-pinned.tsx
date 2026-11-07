"use client";

import type { ReactNode } from "react";
import { MoreHorizontal, Pin, PinOff, PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MoveDirection } from "@/lib/board-layout";

/**
 * Pieces for boards whose columns can be docked ("pinned") on the right, outside the horizontal scroller.
 * The pure layout model is lib/board-layout.ts; this file is the chrome. See the usage note on `Board`
 * in ./board.tsx for how a board wires the two together.
 */

/** What a column needs to offer pin / reorder / collapse. Passed to `BoardColumn` as `layoutControls`. */
export type BoardColumnLayoutControls = {
  /** Stable column id; stamped on the controls so a board can restore focus after a layout change. */
  columnId: string;
  /** Human name of the column, used in accessible labels ("Pin Later"). */
  label: string;
  pinned: boolean;
  /** False hides pin/unpin (narrow screens, or a mode where unpinning doesn't apply). Reordering stays; collapse follows `onCollapse`. */
  pinnable: boolean;
  onTogglePin: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (direction: MoveDirection) => void;
  /** Present for a docked column that can fold to a tab. */
  onCollapse?: () => void;
};

const ICON_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-text-subtle hover:bg-surface-panel hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The collapse button in a pinned column's header. */
export function ColumnCollapseButton({
  title,
  onClick,
  controls,
  columnId,
  testId = "board-column-collapse",
}: {
  title: string;
  onClick: () => void;
  controls?: string;
  columnId?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Collapse ${title}`}
      aria-controls={controls}
      data-testid={testId}
      data-column-control={columnId ? `${columnId}:collapse` : undefined}
      className={ICON_BUTTON_CLASS}
    >
      <PanelRightClose aria-hidden className="size-4" />
    </button>
  );
}

/** The thin tab a collapsed pinned column leaves behind; clicking it expands the column again. */
export function CollapsedColumnTab({
  title,
  count,
  onClick,
  controls,
  columnId,
  className,
  testId = "board-column-tab",
  ...rest
}: {
  title: string;
  count: number;
  onClick: () => void;
  controls?: string;
  columnId?: string;
  className?: string;
  testId?: string;
} & Omit<React.ComponentProps<"button">, "title" | "onClick" | "className" | "children" | "type">) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Expand ${title} (${count})`}
      aria-expanded={false}
      aria-controls={controls}
      data-testid={testId}
      data-column-control={columnId ? `${columnId}:tab` : undefined}
      {...rest}
      className={cn(
        "flex h-fit w-10 shrink-0 flex-col items-center gap-2 rounded-xl border border-border-default bg-surface-inset py-3 text-text-subtle hover:bg-surface-panel hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <PanelRightOpen aria-hidden className="size-4" />
      <span className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs tabular-nums">{count}</span>
      <span className="text-xs font-semibold [writing-mode:vertical-rl]">{title}</span>
    </button>
  );
}

/**
 * The docked region on the right of a board, a SIBLING of the scrolling `Board` (never inside it), so pinned
 * columns stay put while the rest scroll. Render it only from md up; below md pinned columns belong in the
 * scroller like any other. Renders nothing when empty.
 */
export function BoardPinnedRegion({ children, label = "Pinned columns", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <aside
      data-testid="board-pinned-region"
      data-slot="board-pinned-region"
      aria-label={label}
      className={cn("flex min-h-0 shrink-0 gap-3 border-l border-border-default py-3 pl-3 pr-3 lg:pl-4 lg:pr-4", className)}
    >
      {children}
    </aside>
  );
}

/** Width and body classes for a pinned (docked) column. 18rem is `w-72`, the width scroller columns use too. */
export const PINNED_COLUMN_CLASS = "h-full w-72 min-w-0 flex-none overflow-hidden";
export const PINNED_COLUMN_BODY_CLASS = "min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto";

/**
 * The header controls `BoardColumn` renders for `layoutControls`: a pin toggle (when pinnable), collapse (when
 * pinned) and a "Column options" menu with the keyboard-accessible reorder actions. Everything here is a plain
 * button or menu item, so pin, unpin, collapse and reorder are all operable without a pointer.
 */
export function BoardColumnLayoutActions({ controls }: { controls: BoardColumnLayoutControls }) {
  const { columnId, label, pinned, pinnable, onTogglePin, canMoveLeft, canMoveRight, onMove, onCollapse } = controls;
  const canMove = canMoveLeft || canMoveRight;
  const showMenu = canMove || pinnable || Boolean(onCollapse);
  return (
    <>
      {pinnable ? (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label} to the right`}
          title={pinned ? "Unpin" : "Pin to the right"}
          data-testid="board-column-pin"
          data-column-control={`${columnId}:pin`}
          className={cn(ICON_BUTTON_CLASS, pinned ? "text-text-primary" : "md:opacity-0 md:focus-visible:opacity-100 md:group-hover/board-column:opacity-100")}
        >
          {pinned ? <PinOff aria-hidden className="size-3.5" /> : <Pin aria-hidden className="size-3.5" />}
        </button>
      ) : null}
      {onCollapse ? <ColumnCollapseButton title={label} onClick={onCollapse} columnId={columnId} /> : null}
      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${label} column options`}
            data-testid="board-column-menu"
            data-column-control={`${columnId}:menu`}
            className={ICON_BUTTON_CLASS}
          >
            <MoreHorizontal aria-hidden className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {pinnable ? (
              <DropdownMenuItem onClick={onTogglePin}>{pinned ? "Unpin" : "Pin to the right"}</DropdownMenuItem>
            ) : null}
            {onCollapse ? <DropdownMenuItem onClick={onCollapse}>Collapse</DropdownMenuItem> : null}
            {(pinnable || onCollapse) && canMove ? <DropdownMenuSeparator /> : null}
            {canMove ? (
              <>
                <DropdownMenuItem disabled={!canMoveLeft} onClick={() => onMove("left")}>Move left</DropdownMenuItem>
                <DropdownMenuItem disabled={!canMoveRight} onClick={() => onMove("right")}>Move right</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}
