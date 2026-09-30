/**
 * Shared vocabulary for Objectives that have no cycle (migration 069).
 *
 * Client-safe: no database imports, so components can use it too.
 *
 * A cycle-less Objective is "persistent": it is not bounded by a planning
 * period. It is listed under a fixed pseudo-cycle route (`/okrs/none`) and a
 * labeled card on the OKRs index so it can never vanish from the UI. Real cycle
 * ids are UUIDs, so the slug cannot collide with one.
 */
export const PERSISTENT_CYCLE_SLUG = "none";
export const NO_CYCLE_LABEL = "No cycle / Persistent";

/** Minimal `{ id, title }` reference used by UI props; `id` is a route segment. */
export type CycleRef = { id: string; title: string };

/** A real cycle's reference, or the labeled pseudo-cycle when there is none. */
export function cycleRefOrPersistent(cycle: CycleRef | null | undefined): CycleRef {
  return cycle ?? { id: PERSISTENT_CYCLE_SLUG, title: NO_CYCLE_LABEL };
}

/** Route segment under `/okrs/` for an Objective's cycle id (null -> persistent). */
export function cycleRouteSegment(cycleId: string | null | undefined): string {
  return cycleId ?? PERSISTENT_CYCLE_SLUG;
}
