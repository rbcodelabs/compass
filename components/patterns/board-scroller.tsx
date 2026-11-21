"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Nearest scrollport, including the Board itself, with vertical overflow. */
function overflowingVerticalScroller(start: EventTarget | null, stop: HTMLElement): Element | null {
  let node = start instanceof Element ? start : null;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    if (node === stop) break;
    node = node.parentElement;
  }
  return null;
}

/**
 * The horizontal scroller behind Board. A plain mouse wheel only has a vertical axis, so on a wide board it
 * could never move sideways. On desktop, mainly-vertical wheel input moves a wide board sideways unless a
 * scrollport under the cursor (including the Board) owns vertical scrolling. Nested horizontal scrollports
 * also keep their wheel input. Narrow screens retain native vertical navigation through tall columns.
 */
export function BoardScroller({ children, className, label, wheelSnapControl, dragActive }: { children: ReactNode; className?: string; label: string; wheelSnapControl?: boolean; dragActive?: boolean }) {
  const ref = useRef(null as HTMLDivElement | null);

  useLayoutEffect(() => {
    const board = ref.current;
    // Cleanup restores snap before paint when a drag takes ownership.
    if (!board || dragActive) return;
    let wheelIdle: ReturnType<typeof setTimeout> | undefined;
    function restoreSnap() {
      clearTimeout(wheelIdle);
      wheelIdle = undefined;
      board?.removeAttribute("data-wheel-panning");
    }

    function onWheel(event: WheelEvent) {
      if (!board || event.ctrlKey || event.shiftKey || event.defaultPrevented) return;
      // Match BoardColumn's md scrollports; recheck on each gesture after a viewport resize.
      if (!window.matchMedia("(min-width: 48rem)").matches) return;
      // Mainly sideways gestures (trackpads) are native, or handled by the board that owns them.
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (board.scrollWidth <= board.clientWidth + 1) return;
      if (overflowingVerticalScroller(event.target, board)) return;
      // A nested sideways scroller (e.g. a table) under the cursor keeps its own wheel.
      let node = event.target instanceof Element ? event.target : null;
      while (node && node !== board) {
        if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return;
        node = node.parentElement;
      }
      // deltaMode 1 = lines, 2 = pages; normalise to pixels.
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? board.clientWidth : 1;
      const before = board.scrollLeft;
      const delta = event.deltaY * unit;
      if ((delta < 0 && before <= 0) || (delta > 0 && before >= board.scrollWidth - board.clientWidth)) return;
      const managesSnap = board.hasAttribute("data-wheel-snap-control");
      if (managesSnap) board.dataset.wheelPanning = "true";
      board.scrollLeft += delta;
      if (board.scrollLeft !== before) {
        event.preventDefault();
        if (managesSnap) {
          clearTimeout(wheelIdle);
          wheelIdle = setTimeout(restoreSnap, 400);
        }
      } else if (managesSnap && wheelIdle === undefined) {
        restoreSnap();
      }
    }
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      restoreSnap();
      board.removeEventListener("wheel", onWheel);
    };
  }, [dragActive]);

  return (
    <div ref={ref} role="region" data-wheel-snap-control={wheelSnapControl || undefined} aria-label={label} className={className}>
      {children}
    </div>
  );
}
