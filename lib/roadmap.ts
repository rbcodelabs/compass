/**
 * Central source of truth for roadmap horizons — their display metadata and
 * the several *subsets* different surfaces use. Historically each surface
 * (board column, gantt bar, panel badge, portal column, promote pickers)
 * kept its own `Record<Horizon, …>` and its own hardcoded horizon array, so
 * adding the two GTM launch horizons (LAUNCHING / LAUNCHED) meant touching a
 * dozen files that could silently drift. Everything routes through here now.
 *
 * Import-safe from both client and server (constants + pure helpers only).
 */
import type { Horizon } from "@/lib/types";

export interface HorizonMeta {
  label: string;
  /** Board column dot color (a tailwind `bg-*` utility). */
  accentClass: string;
  /** Board column empty-state copy. */
  emptyText: string;
  /** Gantt bar hex color. */
  color: string;
  /** Panel / badge pill classes (background + text). */
  badgeClass: string;
  /** Public portal column subtitle. */
  portalDescription: string;
}

export const HORIZON_META: Record<Horizon, HorizonMeta> = {
  NOW: {
    label: "Now",
    accentClass: "bg-emerald-500",
    emptyText: "What are you shipping right now?",
    color: "#10b981", // emerald-500
    badgeClass: "bg-indigo-100 text-indigo-700",
    portalDescription: "In progress or shipping soon",
  },
  NEXT: {
    label: "Next",
    accentClass: "bg-blue-500",
    emptyText: "What's coming up after the current work?",
    color: "#3b82f6", // blue-500
    badgeClass: "bg-blue-100 text-blue-700",
    portalDescription: "Planned for the next cycle",
  },
  LATER: {
    label: "Later",
    accentClass: "bg-slate-400",
    emptyText: "Ideas and things on the horizon.",
    color: "#94a3b8", // slate-400
    badgeClass: "bg-slate-100 text-slate-600",
    portalDescription: "On the horizon",
  },
  LAUNCHING: {
    label: "Launching",
    accentClass: "bg-amber-500",
    emptyText: "Items in an active launch with a checklist in flight.",
    color: "#f59e0b", // amber-500
    badgeClass: "bg-amber-100 text-amber-700",
    portalDescription: "Rolling out now",
  },
  LAUNCHED: {
    label: "Launched",
    accentClass: "bg-teal-500",
    emptyText: "Recently launched work.",
    color: "#14b8a6", // teal-500
    badgeClass: "bg-teal-100 text-teal-700",
    portalDescription: "Launched and live",
  },
  SHIPPED: {
    label: "Shipped",
    accentClass: "bg-purple-500",
    emptyText: "Nothing shipped yet",
    color: "#a855f7", // purple-500
    badgeClass: "bg-green-100 text-green-700",
    portalDescription: "Completed and live",
  },
};

/** Canonical display order across every internal surface. */
export const HORIZON_ORDER: Horizon[] = [
  "NOW",
  "NEXT",
  "LATER",
  "LAUNCHING",
  "LAUNCHED",
  "SHIPPED",
];

/** The internal roadmap board renders one column per horizon. */
export const INTERNAL_BOARD_HORIZONS: Horizon[] = HORIZON_ORDER;

/**
 * The two launch-only horizons. An item only ever enters these via
 * `setLaunchTier`, which transactionally creates its checklist — never via a
 * bare move or the generic single-field panel edit.
 */
export const LAUNCH_HORIZONS: Horizon[] = ["LAUNCHING", "LAUNCHED"];

export function isLaunchHorizon(horizon: string): horizon is "LAUNCHING" | "LAUNCHED" {
  return horizon === "LAUNCHING" || horizon === "LAUNCHED";
}

/**
 * Horizons a user may set directly — via a manual drag between columns or the
 * generic single-field panel edit. LAUNCHING is intentionally excluded (only
 * `setLaunchTier` may enter it, so the checklist-creation transaction can't be
 * bypassed); LAUNCHED is allowed as the "launch complete" transition.
 */
export const SETTABLE_HORIZONS: Horizon[] = [
  "NOW",
  "NEXT",
  "LATER",
  "LAUNCHED",
  "SHIPPED",
];

/**
 * Horizons a promote-to-roadmap flow (feedback board, discovery card) may
 * target. Never a launch horizon — those require a tier + checklist.
 */
export const PROMOTE_TARGET_HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER", "SHIPPED"];

/** Quick-add / schedule pickers land items in the near-term planning horizons. */
export const QUICK_ADD_HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER"];

/**
 * Public portal columns. LAUNCHED folds into SHIPPED (see `portalBucketFor`),
 * so it is not its own portal column.
 */
export const PORTAL_HORIZONS: Horizon[] = ["NOW", "NEXT", "LATER", "LAUNCHING", "SHIPPED"];

/**
 * Which portal column a stored horizon appears under. LAUNCHED folds into
 * SHIPPED; anything not shown publicly (shouldn't happen for portal-visible
 * items) returns null.
 */
export function portalBucketFor(horizon: string): Horizon | null {
  if (horizon === "LAUNCHED") return "SHIPPED";
  return (PORTAL_HORIZONS as string[]).includes(horizon) ? (horizon as Horizon) : null;
}
