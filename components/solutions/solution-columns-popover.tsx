"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DiscoverySavedViews } from "@/components/discovery/discovery-saved-views";
import { useSolutionViewState } from "@/components/solutions/solution-saved-views";
import { useSolutionsColumnLayout } from "@/components/solutions/solutions-column-layout";
import { canMoveColumn, moveColumn } from "@/lib/board-layout";
import { solutionsHref } from "@/lib/saved-views/solutions-state";
import { solutionColumnLabel, type SolutionColumns } from "@/lib/saved-views/solution-columns";
import type { SolutionStatus } from "@/lib/types";

type Props = {
  workspaceId: string;
  savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">;
  columns: SolutionColumns;
  /** Live card count per status; a column with cards cannot be hidden. */
  countsByStatus: Readonly<Record<string, number>>;
};

/**
 * Show/hide and reorder the Solutions status columns without dragging, which also covers keyboard
 * users and the stacked mobile layout. Edits are view state, not data, and nothing is saved until Save.
 * Hide/show goes to the URL (`hide`). ORDER is the board's column layout (the same order the dock tabs and the per-column
 * Move left/right use), so reordering here writes the layout store, not the URL.
 */
export function SolutionColumnsPopover({ workspaceId, savedViews, columns: resolved, countsByStatus }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const { urlState: state } = useSolutionViewState(savedViews);
  const { layout, update: updateLayout } = useSolutionsColumnLayout(workspaceId);
  // The server resolves what is hidden; the layout decides the order.
  const columns: SolutionColumns = { ...resolved, order: layout.columnOrder as SolutionStatus[] };

  const forced = new Set<SolutionStatus>(columns.forcedVisible);
  const shown = new Set<SolutionStatus>(columns.visible);
  // Hidden by the layout, whether or not they are showing anyway.
  const hidden = columns.order.filter((status) => !shown.has(status) || forced.has(status));
  const hiddenCount = columns.order.length - columns.visible.length;

  function apply(nextHidden: SolutionStatus[]) {
    // Keep whatever legacy order the URL already carries; the layout, not this, decides the order.
    const order = state.display.columns.status?.order ?? [];
    const next = {
      ...state,
      display: { ...state.display, columns: { ...state.display.columns, status: { order, hidden: nextHidden } } },
    };
    startTransition(() => {
      router.replace(solutionsHref(pathname, next, savedViews.savedViewId), { scroll: false });
    });
  }

  function toggle(status: SolutionStatus) {
    const isHidden = hidden.includes(status);
    apply(isHidden ? hidden.filter((s) => s !== status) : [...hidden, status]);
  }

  // Every column takes part, hidden or not: the popover lists them all.
  const all = { among: () => true };
  function move(status: SolutionStatus, direction: "left" | "right") {
    updateLayout((current) => moveColumn(current, status, direction, all));
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-0" data-testid="columns-trigger" />}>
        <Columns3 />
        Columns
        {hiddenCount > 0 && (
          <span data-testid="columns-hidden-badge" className="rounded-sm bg-muted px-1 text-xs text-text-secondary">
            {hiddenCount} hidden
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-lg bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/10" aria-label="Columns">
        <ul className="grid gap-0.5">
          {columns.order.map((status) => {
            const count = countsByStatus[status] ?? 0;
            const isForced = forced.has(status);
            const isShown = shown.has(status);
            // Hiding a column that holds cards would change nothing (it shows anyway), so it is not offered.
            const cannotHide = isShown && !isForced && count > 0;
            const label = solutionColumnLabel(status);
            return (
              <li key={status} className="flex items-center gap-2 rounded-md px-1.5 py-1" data-testid={`columns-row-${status}`}>
                <Checkbox
                  checked={isShown}
                  disabled={cannotHide}
                  onCheckedChange={() => toggle(status)}
                  aria-label={`Show ${label}`}
                />
                <span className="min-w-0 flex-1 text-sm">
                  {label}
                  <span className="ml-1 text-xs text-text-subtle">
                    {isForced ? "hidden in view, has cards" : cannotHide ? "has cards" : ""}
                  </span>
                </span>
                <Button
                  variant="ghost" size="icon-sm" aria-label={`Move ${label} up`}
                  disabled={!canMoveColumn(layout, status, "left", all)} onClick={() => move(status, "left")}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost" size="icon-sm" aria-label={`Move ${label} down`}
                  disabled={!canMoveColumn(layout, status, "right", all)} onClick={() => move(status, "right")}
                >
                  <ArrowDown />
                </Button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
