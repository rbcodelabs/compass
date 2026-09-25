"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, clampPanelWidth } from "@/lib/panel-pin";

/**
 * The CSS custom property the live drag width is written to. The pinned aside
 * consumes it through a `clamp()` (see `.panel-pinned-surface` in
 * app/globals.css), so the property is the single channel for width — React
 * state and the imperative drag both go through it.
 */
export const PANEL_WIDTH_PROPERTY = "--panel-w";

/** Keyboard step sizes. Coarse enough to be useful, fine enough to aim. */
const STEP = 16;
const STEP_LARGE = 64;

export interface PanelResizeHandleProps {
  /** The committed width, in px. Drives `aria-valuenow`. */
  width: number;
  /**
   * The element carrying `PANEL_WIDTH_PROPERTY` — written imperatively during
   * a drag, and the element whose committed width React owns between drags.
   */
  surfaceRef: React.RefObject<HTMLElement | null>;
  /**
   * Upper bound for *this* gesture, measured from the live layout at
   * pointerdown. See the clamp note below for why this cannot be a constant.
   */
  resolveMaxWidth: () => number;
  /** Called once per gesture, on release, and on every keyboard step. */
  onCommit: (width: number) => void;
  /**
   * Which side of the viewport the panel this handle belongs to is docked on —
   * i.e. which of its edges faces main content, and therefore where the handle
   * sits and which drag direction grows it.
   *
   * Defaults to `"right"`, the original and only behaviour before the agent
   * rail existed, so every existing call site is unchanged by omission.
   */
  side?: "left" | "right";
  className?: string;
}

/**
 * A vertical drag handle on the inward-facing edge of a docked panel — the left
 * edge of a right-hand panel, or the right edge of a left-hand one.
 *
 * Hand-rolled rather than pulling in `react-resizable-panels`: that library
 * wants to own both sides of the divider, has no cookie persistence, and would
 * be a new production dependency for a single handle.
 *
 * ## Why the width is written imperatively
 *
 * A right-hand detail panel hosts nine different entity components, several of
 * them large. Driving width from React state during a drag would re-render
 * that whole subtree on every `pointermove` — 60+ renders per second of work
 * that changes one number. Instead each frame writes a CSS custom property
 * directly on the surface element, coalesced with `requestAnimationFrame` so
 * several moves in one frame cost one write. React state is updated once, on
 * release.
 *
 * ## Why that is safe across a re-render
 *
 * Mid-drag, React's state says (say) 448 while the DOM property says 520. If
 * the parent re-renders during the drag, React diffs `prevProps.style` against
 * `nextProps.style` — *not* against the DOM. Both still say `448px`, so React
 * performs no write and does not clobber the imperative value. The drag
 * survives. (This is also why the commit at the end must go through state: it
 * is the only point where the two views of the width are reconciled.)
 *
 * ## Why the gesture has its own clamp
 *
 * `clampPanelWidth` guards what gets persisted, and a CSS `clamp()` guards
 * window resizes, but neither is enough during a drag. If the panel is only
 * clamped on commit, it keeps tracking the pointer past the legal maximum and
 * then snaps back on release. If it is clamped against a *constant*, the bound
 * ignores how much room main content actually has right now — which depends on
 * the viewport and on whether the sidebar is collapsed. So `resolveMaxWidth`
 * is called once per gesture, at pointerdown, and measures the live layout.
 */
export function PanelResizeHandle({
  width,
  surfaceRef,
  resolveMaxWidth,
  onCommit,
  side = "right",
  className,
}: PanelResizeHandleProps) {
  // Which way the pointer has to travel to make the panel wider, as a sign:
  // toward the centre of the viewport. For a right-hand panel that is leftward
  // (decreasing clientX, hence -1); for a left-hand rail it is rightward. Every
  // direction-dependent branch below reduces to this one number, so the drag and
  // the keyboard cannot drift out of agreement.
  const growSign = side === "right" ? -1 : 1;
  // All drag bookkeeping lives in a ref: none of it should cause a render.
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    maxWidth: number;
    latest: number;
    frame: number | null;
  } | null>(null);

  const writeLiveWidth = React.useCallback(
    (next: number) => {
      surfaceRef.current?.style.setProperty(PANEL_WIDTH_PROPERTY, `${next}px`);
    },
    [surfaceRef],
  );

  // Drag state is torn down from four different events (up, cancel, lost
  // capture, unmount). Funnelling them through one idempotent function is what
  // keeps a double-fire from committing twice or leaving the global
  // cursor lock on.
  const endDrag = React.useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;

      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      delete document.documentElement.dataset.panelResizing;

      if (commit) {
        writeLiveWidth(drag.latest);
        onCommit(drag.latest);
      } else {
        writeLiveWidth(drag.startWidth);
      }
    },
    [onCommit, writeLiveWidth],
  );

  // A drag interrupted by an unmount (route change, panel closed by a hotkey)
  // must not leave the document-wide cursor/selection lock behind.
  React.useEffect(() => () => endDrag(false), [endDrag]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only; a right-click drag is not a resize.
    if (event.button !== 0 || dragRef.current) return;

    const startWidth = clampPanelWidth(width);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      maxWidth: Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, resolveMaxWidth())),
      latest: startWidth,
      frame: null,
    };

    // Pointer capture is what makes the drag survive the pointer leaving this
    // 1px-wide element — without it the gesture dies the moment the cursor
    // outruns the handle, which it does immediately. It also means the move
    // and up listeners can stay as React props on this element rather than
    // being attached to `window`.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.dataset.panelResizing = "";
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    // Dragging toward the centre of the viewport makes the panel wider, in
    // whichever direction that is for this side (see `growSign`).
    const raw = drag.startWidth + growSign * (event.clientX - drag.startX);
    drag.latest = Math.round(Math.min(drag.maxWidth, Math.max(PANEL_WIDTH_MIN, raw)));

    if (drag.frame !== null) return; // a write is already queued for this frame
    drag.frame = requestAnimationFrame(() => {
      const current = dragRef.current;
      if (!current) return;
      current.frame = null;
      writeLiveWidth(current.latest);
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag(true);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const max = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, resolveMaxWidth()));
    const step = event.shiftKey ? STEP_LARGE : STEP;
    let next: number | null = null;

    // Mirrors the drag exactly: the arrow that points the same way a widening
    // drag would travel grows the panel, and the opposite one shrinks it. So
    // Left grows a right-hand panel and Right grows a left-hand rail, with no
    // second source of truth for the direction.
    const arrow = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (arrow !== 0) next = width + (arrow === growSign ? step : -step);
    else if (event.key === "Home") next = PANEL_WIDTH_MIN;
    else if (event.key === "End") next = max;
    if (next === null) return;

    event.preventDefault();
    const clamped = Math.min(max, Math.max(PANEL_WIDTH_MIN, next));
    if (clamped === width) return;
    writeLiveWidth(clamped);
    onCommit(clamped);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH_MIN}
      // The *absolute* maximum, not the effective one. On a narrow desktop the
      // live bound from resolveMaxWidth() is lower, so End stops short of this
      // number. Reporting the effective value would mean recomputing layout on
      // every window resize (a ResizeObserver this component otherwise does not
      // need); reporting the absolute bound is the documented, stable contract
      // and never under-reports the range. Revisit if AT feedback says the gap
      // is confusing in practice.
      aria-valuemax={PANEL_WIDTH_MAX}
      tabIndex={0}
      data-slot="panel-resize-handle"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onKeyDown={handleKeyDown}
      className={cn(
        // The visible divider is 1px, but `after:` widens the hit target to a
        // comfortable 9px without adding any layout width — a 1px drag target
        // is unusable with a mouse and impossible with a trackpad.
        "absolute inset-y-0 z-10 w-px cursor-col-resize touch-none select-none bg-border-default",
        "after:absolute after:inset-y-0 after:w-[9px] after:content-['']",
        // Emitted as one side or the other, never both: tailwind-merge treats
        // `left-0` and `right-0` as different properties and would happily keep
        // both, stretching the handle across the panel.
        side === "right"
          ? "left-0 after:-left-1"
          : "right-0 after:-right-1",
        "hover:bg-border-interactive focus-visible:bg-border-interactive focus-visible:outline-none",
        className,
      )}
    />
  );
}
