"use client";

import { useEffect, useRef, type ReactNode } from "react";

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
export function BoardScroller({ children, className, label, wheelSnapControl }: { children: ReactNode; className?: string; label: string; wheelSnapControl?: boolean }) {
  const ref = useRef(null as HTMLDivElement | null);

  useEffect(() => {
    const board = ref.current;
    if (!board) return;
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
      // Keep the wheel's pixel offsets between events on boards that opt
      // into resting snap points. Re-enabling snap between inputs can undo them.
      if (board.hasAttribute("data-wheel-snap-control")) board.dataset.wheelPanning = "true";
      const before = board.scrollLeft;
      board.scrollLeft += event.deltaY * unit;
      if (board.scrollLeft !== before) event.preventDefault();
    }
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={ref} role="region" data-wheel-snap-control={wheelSnapControl || undefined} aria-label={label} className={className}>
      {children}
    </div>
  );
}
