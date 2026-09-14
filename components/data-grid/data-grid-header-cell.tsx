"use client";

import type { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { GridAlign, GridSortDirection } from "./types";

/**
 * Sticky-header styling, shared by every `<th>` the grid renders (including the
 * injected selection column, which is built in `data-grid.tsx`).
 *
 * Three details are load-bearing:
 *
 *  1. Sticky goes on the `<th>`, not on `<thead>` — per-cell sticky is the
 *     universally supported form.
 *  2. The background must be on the cell. Tailwind's preflight sets
 *     `border-collapse: collapse`, under which a `<tr>`/`<thead>` background
 *     does not reliably paint behind a sticky cell and body rows show through.
 *     `bg-surface-panel` resolves to `--card`, which is defined in both light
 *     and dark mode, so no `dark:` variant is needed.
 *  3. The underline is an inset box-shadow, NOT `border-b`. Collapsed borders
 *     belong to the table grid rather than the cell, so they do not travel with
 *     a sticky element — the rule would detach and scroll away while the header
 *     text stayed put. A shadow paints inside the cell's own box.
 *
 * `z-20` is scoped by the `isolate` on the scroll container, so it cannot
 * compete with page chrome in the root stacking context.
 */
export const STICKY_HEADER_CELL_CLASS =
  "sticky top-0 z-20 bg-surface-panel shadow-[inset_0_-1px_0_var(--border-default)]";

export type DataGridHeaderCellProps = {
  columnId: string;
  label: ReactNode;
  /** Plain-text label used for accessible names. */
  labelText: string;
  sortKey?: string;
  sorted?: GridSortDirection | false;
  onSort?: (sortKey: string) => void;
  align?: GridAlign;
  /** `false` pins the column, disabling drag reorder. */
  movable?: boolean;
  className?: string;
};

/**
 * One `<th>`.
 *
 * Accessibility notes:
 *  - `aria-sort` lives on the `<th>` itself, which is what screen readers read.
 *  - the sort control is a real `<Button>`, not a click handler on the `<th>`,
 *    so it is focusable and operable from the keyboard.
 *  - dnd-kit's `attributes` are deliberately **not** spread onto the `<th>`:
 *    they set `role="button"` and `tabIndex`, which would clobber the column
 *    header semantics and the `aria-sort` announcement. Keyboard reordering is
 *    provided instead by the "Move up"/"Move down" items in the column menu.
 */
export function DataGridHeaderCell({
  columnId,
  label,
  labelText,
  sortKey,
  sorted = false,
  onSort,
  align = "start",
  movable = true,
  className,
}: DataGridHeaderCellProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: columnId,
    disabled: !movable,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const ariaSort =
    sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";

  const SortIcon =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;

  // `aria-sort` describes the column, so it must be present on any sortable
  // column even when no change handler is wired — a sorted column that does not
  // announce its direction is the bug this separation exists to prevent.
  const sortable = Boolean(sortKey);
  // The toggle button only makes sense when something will act on the click.
  const canToggle = Boolean(sortKey && onSort);

  return (
    <TableHead
      ref={setNodeRef}
      style={style}
      data-testid={`grid-head-${columnId}`}
      data-col={columnId}
      data-dragging={isDragging ? "true" : undefined}
      aria-sort={sortable ? ariaSort : undefined}
      className={cn(
        "text-xs font-medium text-text-subtle",
        STICKY_HEADER_CELL_CLASS,
        align === "end" && "text-right",
        // dnd-kit transforms this cell in place during a column drag. A
        // transform creates a containing block for descendants and browsers
        // disagree about transformed sticky elements, so the cell drops back to
        // `static` for the duration of the drag and returns to sticky after.
        isDragging && "static opacity-60",
        movable && "touch-none",
        className,
      )}
      {...(movable ? listeners : {})}
    >
      {canToggle ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={cn(
            "-mx-2 h-6 font-medium text-text-subtle",
            align === "end" && "ml-auto",
          )}
          onClick={() => onSort?.(sortKey as string)}
          aria-label={
            sorted === "asc"
              ? `${labelText}, sorted ascending. Activate to sort descending.`
              : sorted === "desc"
                ? `${labelText}, sorted descending. Activate to sort ascending.`
                : `Sort by ${labelText}`
          }
        >
          {label}
          <SortIcon
            aria-hidden
            className={cn(
              "size-3",
              sorted === false && "text-text-disabled",
            )}
          />
        </Button>
      ) : (
        <span className={cn("block", align === "end" && "text-right")}>{label}</span>
      )}
    </TableHead>
  );
}
