"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export const FLIP_DURATION_MS = 220;
export const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** A snapshot older than this predates the data that arrived, so it is discarded rather than animated from. */
const SNAPSHOT_MAX_AGE_MS = 10_000;

export type FlipPoint = { left: number; top: number };

export type FlipPlan = {
  moves: Array<{ id: string; dx: number; dy: number }>;
  entering: string[];
};

/**
 * Pure diff of two position snapshots. A card present in both that shifted by
 * more than a pixel is a move (the inverse delta is what the animation starts
 * from); a card only in `next` is new. Cards only in `prev` are gone - their
 * DOM node no longer exists, so there is nothing left to animate.
 */
export function planFlip(prev: ReadonlyMap<string, FlipPoint>, next: ReadonlyMap<string, FlipPoint>): FlipPlan {
  const moves: FlipPlan["moves"] = [];
  const entering: string[] = [];
  for (const [id, to] of next) {
    const from = prev.get(id);
    if (!from) {
      entering.push(id);
      continue;
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moves.push({ id, dx, dy });
  }
  return { moves, entering };
}

function measure(container: HTMLElement): Map<string, FlipPoint> {
  const points = new Map<string, FlipPoint>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    points.set(id, { left: rect.left, top: rect.top });
  }
  return points;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * FLIP (first, last, invert, play) animation for cards that move between
 * columns or within a column because *the server data changed*.
 *
 * It is deliberately driven by an explicit `capture()` call plus a
 * `generation` counter instead of measuring on every render. Measuring every
 * commit would also catch the user's own drags, where @dnd-kit already owns the
 * element's transform (and `getBoundingClientRect` includes it); animating
 * there would fight the drag. The flow is: the live-refresh hook calls
 * `capture()` just before `router.refresh()`, the synced-state hook bumps
 * `generation` when the fresh data is adopted, and the layout effect below
 * diffs the two layouts. A generation bump with no recent snapshot (e.g. the
 * user's own save revalidating) animates nothing.
 *
 * Cards are tagged with `data-flip-id`. Honors prefers-reduced-motion. Uses
 * the Web Animations API, which composes with (and cleans up after) inline
 * transforms without touching them.
 */
export function useFlipAnimation(generation: number): {
  containerRef: RefObject<HTMLDivElement | null>;
  capture: () => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<{ points: Map<string, FlipPoint>; at: number } | null>(null);
  const handledGenerationRef = useRef(generation);

  const capture = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    snapshotRef.current = { points: measure(container), at: Date.now() };
  }, []);

  useLayoutEffect(() => {
    if (handledGenerationRef.current === generation) return;
    handledGenerationRef.current = generation;

    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    const container = containerRef.current;
    if (!snapshot || !container) return;
    if (Date.now() - snapshot.at > SNAPSHOT_MAX_AGE_MS) return;
    if (prefersReducedMotion()) return;

    const plan = planFlip(snapshot.points, measure(container));
    const byId = new Map<string, HTMLElement>();
    for (const el of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      if (el.dataset.flipId) byId.set(el.dataset.flipId, el);
    }
    const timing = { duration: FLIP_DURATION_MS, easing: FLIP_EASING };
    for (const { id, dx, dy } of plan.moves) {
      byId.get(id)?.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], timing);
    }
    for (const id of plan.entering) {
      byId.get(id)?.animate?.([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }], timing);
    }
  }, [generation]);

  return { containerRef, capture };
}
