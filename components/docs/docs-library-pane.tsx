"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  DOCS_LIBRARY_MIN_MAIN,
  DOCS_LIBRARY_WIDTH_DEFAULT,
  DOCS_LIBRARY_WIDTH_MAX,
  DOCS_LIBRARY_WIDTH_MIN,
  clampDocsLibraryWidth,
} from "@/lib/docs-library-pane";
import { useDocsLibrary } from "./docs-library-context";
import { DocTreeSidebar, type DocTreeItem } from "./doc-tree-sidebar";
import type { ArtifactNavItem } from "./artifact-nav";

const WIDTH_PROPERTY = "--docs-library-w";

/** Keyboard step sizes. */
const STEP = 16;
const STEP_LARGE = 64;

interface DocsLibraryPaneProps {
  docs: DocTreeItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  artifacts: ArtifactNavItem[];
}

/**
 * Desktop (md+) home of the Docs "Library" sidebar: drag-to-resize and
 * collapse-to-nothing, both persisted in a cookie (see lib/docs-library-pane.ts).
 *
 * The drag writes `--docs-library-w` straight onto the element each frame
 * instead of going through React state, for the same reason
 * `PanelResizeHandle` does: a pointermove at 60Hz should not re-render the
 * whole doc tree. State is reconciled once, on release. The CSS `clamp()` on
 * `width` is the third guard (window resize, where no JS runs) and keeps the
 * editor at `DOCS_LIBRARY_MIN_MAIN` or wider.
 */
export function DocsLibraryPane({
  docs,
  orgSlug,
  workspaceSlug,
  workspaceId,
  artifacts,
}: DocsLibraryPaneProps) {
  const { collapsed, width, setCollapsed, setWidth } = useDocsLibrary();
  const asideRef = React.useRef<HTMLElement>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    maxWidth: number;
    latest: number;
    frame: number | null;
  } | null>(null);

  const writeLiveWidth = React.useCallback((next: number) => {
    asideRef.current?.style.setProperty(WIDTH_PROPERTY, `${next}px`);
  }, []);

  // Upper bound measured from the live layout: whatever leaves main content
  // its floor, never more than the absolute maximum.
  const resolveMaxWidth = React.useCallback(() => {
    const container = asideRef.current?.parentElement;
    const room = container
      ? container.clientWidth - DOCS_LIBRARY_MIN_MAIN
      : DOCS_LIBRARY_WIDTH_MAX;
    return Math.max(DOCS_LIBRARY_WIDTH_MIN, Math.min(DOCS_LIBRARY_WIDTH_MAX, room));
  }, []);

  const commitWidth = React.useCallback(
    (next: number) => {
      setWidth(clampDocsLibraryWidth(next));
    },
    [setWidth],
  );

  const endDrag = React.useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      delete document.documentElement.dataset.panelResizing;
      if (commit) {
        writeLiveWidth(drag.latest);
        commitWidth(drag.latest);
      } else {
        writeLiveWidth(drag.startWidth);
      }
    },
    [commitWidth, writeLiveWidth],
  );

  // An unmount mid-drag (route change) must not leave the cursor lock on.
  React.useEffect(() => () => endDrag(false), [endDrag]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragRef.current) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      maxWidth: resolveMaxWidth(),
      latest: width,
      frame: null,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.dataset.panelResizing = "";
    event.preventDefault();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Left-docked: dragging right grows it.
    const raw = drag.startWidth + (event.clientX - drag.startX);
    drag.latest = Math.round(
      Math.min(drag.maxWidth, Math.max(DOCS_LIBRARY_WIDTH_MIN, raw)),
    );
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      const current = dragRef.current;
      if (!current) return;
      current.frame = null;
      writeLiveWidth(current.latest);
    });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag(true);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const max = resolveMaxWidth();
    const step = event.shiftKey ? STEP_LARGE : STEP;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "Home") next = DOCS_LIBRARY_WIDTH_MIN;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(max, Math.max(DOCS_LIBRARY_WIDTH_MIN, next));
    if (clamped === width) return;
    writeLiveWidth(clamped);
    commitWidth(clamped);
  }

  function handleDoubleClick() {
    writeLiveWidth(DOCS_LIBRARY_WIDTH_DEFAULT);
    commitWidth(DOCS_LIBRARY_WIDTH_DEFAULT);
  }

  // Collapsed means gone: no rail. The aside stays mounted-but-hidden so the
  // search box and type filter survive a collapse/expand round trip; the expand
  // control lives beside the page title (DocsLibraryExpandButton).
  return (
      <aside
        ref={asideRef}
        data-testid="library-pane"
        data-collapsed={collapsed || undefined}
        style={
          {
            [WIDTH_PROPERTY]: `${width}px`,
            width: `clamp(${DOCS_LIBRARY_WIDTH_MIN}px, var(${WIDTH_PROPERTY}, ${DOCS_LIBRARY_WIDTH_DEFAULT}px), max(${DOCS_LIBRARY_WIDTH_MIN}px, min(${DOCS_LIBRARY_WIDTH_MAX}px, 100% - ${DOCS_LIBRARY_MIN_MAIN}px)))`,
          } as React.CSSProperties
        }
        className={cn(
          "relative hidden md:flex min-h-0 shrink-0 flex-col border-r border-border-default bg-surface-panel p-2",
          collapsed && "md:hidden",
        )}
      >
        <DocTreeSidebar
          docs={docs}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          artifacts={artifacts}
          onCollapse={() => setCollapsed(true)}
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize library"
          aria-valuenow={width}
          aria-valuemin={DOCS_LIBRARY_WIDTH_MIN}
          aria-valuemax={DOCS_LIBRARY_WIDTH_MAX}
          tabIndex={collapsed ? -1 : 0}
          data-testid="library-resize-handle"
          title="Drag to resize · double-click to reset"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          onKeyDown={handleKeyDown}
          onDoubleClick={handleDoubleClick}
          className={cn(
            // 1px visible divider, 9px hit target via the pseudo-element.
            "absolute inset-y-0 right-0 z-10 w-px cursor-col-resize touch-none select-none bg-border-default",
            "after:absolute after:inset-y-0 after:-right-1 after:w-[9px] after:content-['']",
            "hover:bg-border-interactive focus-visible:bg-border-interactive focus-visible:outline-none",
          )}
        />
      </aside>
  );
}
