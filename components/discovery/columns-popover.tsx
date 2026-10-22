"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDiscoveryViewState, type DiscoverySavedViews } from "@/components/discovery/discovery-saved-views";
import { opportunitiesHref } from "@/lib/saved-views/opportunities-state";
import { OPPORTUNITY_COLUMN_META, type OpportunityColumns } from "@/lib/saved-views/opportunity-columns";
import type { OpportunityStatus } from "@/lib/types";

type Props = {
  savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">;
  columns: OpportunityColumns;
  /** Live card count per status; a column with cards cannot be hidden. */
  countsByStatus: Readonly<Record<string, number>>;
};

/**
 * Show/hide and reorder the status columns without dragging, which also covers keyboard
 * users and the stacked mobile layout. Edits are view state, not data: they go to the URL
 * (`order`, `hide`) and mark a selected saved view modified. Nothing is saved until Save.
 */
export function ColumnsPopover({ savedViews, columns, countsByStatus }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const { state } = useDiscoveryViewState(savedViews);

  const forced = new Set<OpportunityStatus>(columns.forcedVisible);
  const shown = new Set<OpportunityStatus>(columns.visible);
  // Hidden by the layout, whether or not they are showing anyway.
  const hidden = columns.order.filter((status) => !shown.has(status) || forced.has(status));
  const hiddenCount = columns.order.length - columns.visible.length;

  function apply(order: OpportunityStatus[], nextHidden: OpportunityStatus[]) {
    const next = {
      ...state,
      display: { ...state.display, columns: { ...state.display.columns, status: { order, hidden: nextHidden } } },
    };
    startTransition(() => {
      router.replace(opportunitiesHref(pathname, next, savedViews.savedViewId), { scroll: false });
    });
  }

  function toggle(status: OpportunityStatus) {
    const isHidden = hidden.includes(status);
    apply(columns.order, isHidden ? hidden.filter((s) => s !== status) : [...hidden, status]);
  }

  function move(status: OpportunityStatus, delta: -1 | 1) {
    const from = columns.order.indexOf(status);
    const to = from + delta;
    if (to < 0 || to >= columns.order.length) return;
    const order = [...columns.order];
    [order[from], order[to]] = [order[to], order[from]];
    apply(order, hidden);
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-0" data-testid="columns-trigger" />}>
        <Columns3 />
        Columns
        {hiddenCount > 0 && (
          <span data-testid="columns-hidden-badge" className="rounded-sm bg-surface-sunken px-1 text-xs text-text-secondary">
            {hiddenCount} hidden
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-lg border border-border-default bg-surface-raised p-2 shadow-md" aria-label="Columns">
        <ul className="grid gap-0.5">
          {columns.order.map((status, index) => {
            const count = countsByStatus[status] ?? 0;
            const isForced = forced.has(status);
            const isShown = shown.has(status);
            // Hiding a column that holds cards would change nothing (it shows anyway), so it is not offered.
            const cannotHide = isShown && !isForced && count > 0;
            const { label } = OPPORTUNITY_COLUMN_META[status];
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
                  disabled={index === 0} onClick={() => move(status, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost" size="icon-sm" aria-label={`Move ${label} down`}
                  disabled={index === columns.order.length - 1} onClick={() => move(status, 1)}
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
