/**
 * Zoom-driven semantic tiers for the Canvas viewer.
 *
 * Pure functions, no Prisma/React dependency — same shape as
 * lib/canvas/edges.ts, fully unit-testable with plain values.
 *
 * Ships three real tiers — T0, T1, T2 — not four. The design doc's T3
 * ("zoomed in on a single node... full card... 'Edit' affordance") only
 * makes sense once click-to-focus or per-node expanded detail exists;
 * neither does today, and every node component already renders its full
 * designed content at every zoom level (there's no simplified-vs-expanded
 * card state to switch between). T2 is "the full graph, same as today."
 * T3 stays a reserved name for a future increment, not a fake tier with no
 * real difference from T2.
 *
 * Tier is derived purely from the current zoom level (see
 * components/canvas/canvas-flow.tsx's onMoveEnd handler) — no click-to-focus
 * animated camera, no URL deep-linking, no T0 squad-clustering. All deferred
 * to future increments per the plan.
 */
import type { CanvasNodeType } from "./layout";

export type CanvasTier = "T0" | "T1" | "T2";

// Starting estimates — tune empirically once tested against real zoom
// behavior, same as layout.ts's NODE_SIZE constants were.
const TIER_ZOOM_THRESHOLDS = { T0: 0.4, T1: 0.75 } as const;

export function getTierForZoom(zoom: number): CanvasTier {
  if (zoom < TIER_ZOOM_THRESHOLDS.T0) return "T0";
  if (zoom < TIER_ZOOM_THRESHOLDS.T1) return "T1";
  return "T2";
}

const TIER_VISIBLE_TYPES: Record<CanvasTier, ReadonlySet<CanvasNodeType>> = {
  T0: new Set(["objective"]),
  T1: new Set(["objective", "keyResult"]),
  T2: new Set([
    "objective",
    "keyResult",
    "opportunity",
    "solution",
    "assumption",
    "experiment",
    "roadmapItem",
  ]),
};

export function isNodeTypeVisibleAtTier(type: CanvasNodeType, tier: CanvasTier): boolean {
  return TIER_VISIBLE_TYPES[tier].has(type);
}

/** Human-readable labels matching the design doc's own tier names, shown in
 * the read-only tier indicator badge. */
export const TIER_LABELS: Record<CanvasTier, string> = {
  T0: "Portfolio",
  T1: "Cycle",
  T2: "Detail",
};
