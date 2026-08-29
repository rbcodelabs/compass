import type { SolutionStatus } from "@/lib/types";

/**
 * Single source of truth for how a Solution's status is presented.
 *
 * This previously lived in three places that had drifted apart:
 *
 *   - `solution-card.tsx` — dark-mode variants, purple SHIPPED, "In Delivery"
 *   - `solution-panel.tsx` — no dark variants, SHIPPED green (identical to
 *     VALIDATED, so the two were indistinguishable), "In delivery", plus a
 *     `SELECTED` key that isn't in the SolutionStatus union at all
 *   - `opportunity-panel.tsx` — className-only map missing VALIDATED and
 *     IN_DELIVERY entirely, so the two most common mid-lifecycle statuses fell
 *     through to a grey default and rendered the raw `IN_DELIVERY` enum
 *
 * Consolidated on the card's values (they carry dark-mode variants and keep
 * SHIPPED visually distinct from VALIDATED) with the panel's sentence-case
 * label, which is what the e2e specs already assert on.
 */
export const SOLUTION_STATUS: Record<
  SolutionStatus,
  { label: string; className: string }
> = {
  IDEA: {
    label: "Idea",
    className: "bg-secondary text-secondary-foreground",
  },
  VALIDATED: {
    label: "Validated",
    className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  },
  IN_DELIVERY: {
    label: "In delivery",
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  SHIPPED: {
    label: "Shipped",
    className: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
  KILLED: {
    label: "Killed",
    className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  },
};

/** Every status, in lifecycle order — for the panel's status dropdown. */
export const SOLUTION_STATUS_ORDER: SolutionStatus[] = [
  "IDEA",
  "VALIDATED",
  "IN_DELIVERY",
  "SHIPPED",
  "KILLED",
];

/**
 * Presentation for a status that arrives as a plain `string` (panel payloads
 * are untyped JSON). Falls back to showing the raw value rather than rendering
 * an empty badge, so unexpected data is visible instead of silently blank.
 */
export function solutionStatusBadge(status: string): {
  label: string;
  className: string;
} {
  return (
    SOLUTION_STATUS[status as SolutionStatus] ?? {
      label: status,
      className: "bg-secondary text-secondary-foreground",
    }
  );
}
