"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export const FLIP_DURATION_MS = 220;
export const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** A snapshot older than this predates the data that arrived, so it is discarded rather than animated from. */
const SNAPSHOT_MAX_AGE_MS = 10_000;

export type FlipPoint = { left: number; top: number; width?: number; height?: number };

export type FlipPlan = {
  moves: Array<{ id: string; dx: number; dy: number }>;
  entering: string[];
  /** Present before, absent after: the card was removed. */
  leaving: string[];
};

/**
 * Pure diff of two position snapshots. A card present in both that shifted by
 * more than a pixel is a move (the inverse delta is what the animation starts
 * from); a card only in `next` is new; a card only in `prev` was removed (its
 * DOM node is gone, so the hook fades out a ghost clone captured earlier).
 */
export function planFlip(prev: ReadonlyMap<string, FlipPoint>, next: ReadonlyMap<string, FlipPoint>): FlipPlan {
  const moves: FlipPlan["moves"] = [];
  const entering: string[] = [];
  const leaving = [...prev.keys()].filter((id) => !next.has(id));
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
  return { moves, entering, leaving };
}

function measure(container: HTMLElement, clones?: Map<string, HTMLElement>): Map<string, FlipPoint> {
  const points = new Map<string, FlipPoint>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    points.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    clones?.set(id, el.cloneNode(true) as HTMLElement);
  }
  return points;
}

/**
 * Fades a removed card out where it used to be, using the clone captured
 * before the refresh. Fixed-positioned on <body> so it survives the
 * column/list that owned it being re-rendered; inert and hidden from AT.
 */
function playGhostFadeOut(clone: HTMLElement, at: FlipPoint, timing: KeyframeAnimationOptions) {
  if (typeof clone.animate !== "function") return;
  clone.removeAttribute("data-flip-id");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  Object.assign(clone.style, {
    position: "fixed",
    left: `${at.left}px`,
    top: `${at.top}px`,
    width: `${at.width ?? 0}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "50",
    transform: "none",
  });
  document.body.appendChild(clone);
  const animation = clone.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: "forwards" });
  const remove = () => clone.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
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
export function useFlipAnimation(
  generation: number,
  /** Reuse a ref the component already attaches to its root instead of the returned one. */
  existingRef?: RefObject<HTMLDivElement | null>,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  capture: () => void;
} {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const containerRef = existingRef ?? ownRef;
  const snapshotRef = useRef<{
    points: Map<string, FlipPoint>;
    clones: Map<string, HTMLElement>;
    at: number;
  } | null>(null);
  const handledGenerationRef = useRef(generation);

  const capture = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const clones = new Map<string, HTMLElement>();
    snapshotRef.current = { points: measure(container, clones), clones, at: Date.now() };
    // containerRef is a stable ref object
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    for (const id of plan.leaving) {
      const clone = snapshot.clones.get(id);
      const at = snapshot.points.get(id);
      if (clone && at) playGhostFadeOut(clone, at, timing);
    }
  }, [generation, containerRef]);

  return { containerRef, capture };
}
