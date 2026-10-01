import type { ResolvedEntityLabel } from "@/lib/thinking-model/labels";
import { CLASSIC_THINKING_MODEL } from "@/lib/thinking-model/resolve";

/**
 * Shared vocabulary for Objectives that have no cycle (migration 070).
 *
 * Client-safe: no database imports, so components can use it too.
 *
 * A cycle-less Objective is "persistent": it is not bounded by a planning
 * period. It is listed under a fixed pseudo-cycle route (`/okrs/none`) and a
 * labeled card on the OKRs index so it can never vanish from the UI. Real cycle
 * ids are UUIDs, so the slug cannot collide with one.
 */
export const PERSISTENT_CYCLE_SLUG = "none";

/**
 * The pseudo-cycle's name in a workspace's own vocabulary. Under CLASSIC (and
 * every preset today, since Cycle is not renameable) this is exactly the text
 * #332 shipped: "No cycle / Persistent".
 */
export function noCycleLabel(cycle: Pick<ResolvedEntityLabel, "lower">): string {
  return `No ${cycle.lower} / Persistent`;
}

/**
 * The CLASSIC wording, for surfaces that are deliberately preset-independent
 * (MCP tool output, which never varies by workspace thinking model).
 */
export const NO_CYCLE_LABEL = noCycleLabel(CLASSIC_THINKING_MODEL.labels.cycle);

/** Minimal `{ id, title }` reference used by UI props; `id` is a route segment. */
export type CycleRef = { id: string; title: string };

/** A real cycle's reference, or the labeled pseudo-cycle when there is none. */
export function cycleRefOrPersistent(
  cycle: CycleRef | null | undefined,
  noCycleTitle: string = NO_CYCLE_LABEL,
): CycleRef {
  return cycle ?? { id: PERSISTENT_CYCLE_SLUG, title: noCycleTitle };
}

/** Route segment under `/okrs/` for an Objective's cycle id (null -> persistent). */
export function cycleRouteSegment(cycleId: string | null | undefined): string {
  return cycleId ?? PERSISTENT_CYCLE_SLUG;
}
