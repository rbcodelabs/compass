"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Nearest ancestor (up to stop) that scrolls vertically on its own and has overflow to scroll. */
function overflowingVerticalScroller(start: EventTarget | null, stop: HTMLElement): HTMLElement | null {
  let node = start instanceof HTMLElement ? start : null;
  while (node && node !== stop) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The horizontal scroller behind Board. A plain mouse wheel only has a vertical axis, so on a wide board it
 * could never move sideways. Here a mainly-vertical wheel turn scrolls the board sideways, unless the cursor is over
 * a column that is itself scrolling vertically (then the column keeps the wheel; Shift+wheel, the column headers,
 * the gaps between columns and the scrollbar still move the board).
 */
export function BoardScroller({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  const ref = useRef(null as HTMLDivElement | null);

  useEffect(() => {
    const board = ref.current;
    if (!board) return;
    function onWheel(event: WheelEvent) {
      if (!board || event.ctrlKey || event.shiftKey || event.defaultPrevented) return;
      // Mainly sideways gestures (trackpads) are native, or handled by the board that owns them.
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (board.scrollWidth <= board.clientWidth + 1) return;
      if (overflowingVerticalScroller(event.target, board)) return;
      // A nested sideways scroller (e.g. a table) under the cursor keeps its own wheel.
      let node = event.target instanceof HTMLElement ? event.target : null;
      while (node && node !== board) {
        if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return;
        node = node.parentElement;
      }
      // deltaMode 1 = lines, 2 = pages; normalise to pixels.
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? board.clientWidth : 1;
      const before = board.scrollLeft;
      board.scrollLeft += event.deltaY * unit;
      if (board.scrollLeft !== before) event.preventDefault();
    }
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={ref} role="region" aria-label={label} className={className}>
      {children}
    </div>
  );
}
