"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { BoardColumnLayoutControls, BoardDockTab } from "@/components/patterns/board-pinned";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  canMoveColumn,
  collapseDock,
  moveColumn,
  setActiveColumn,
  togglePinColumn,
  type BoardLayout,
  type MoveDirection,
} from "@/lib/board-layout";
import type { BoardLayoutController } from "@/components/patterns/use-board-layout-store";

/**
 * The dock wiring every status board repeats (see lib/board-layout.ts for the model): which of the layout's columns are
 * rendered right now, which of those are docked, which docked column the open panel shows, the column menu's controls,
 * tab selection, and keyboard focus restoration after a layout change.
 *
 *  - `renderedIds` is the set of columns the board draws at the moment, in any order (a column hidden because it is empty,
 *    or behind a toggle, is simply absent). The layout keeps its pin either way; hidden ids are only filtered out of what
 *    renders, the way the roadmap filters hidden horizons.
 *  - Docking applies from md up. Below md every column is an ordinary scroller column, in the layout's order.
 */
export function useBoardDock({
  controller,
  renderedIds,
  labelOf,
  containerRef,
}: {
  controller: BoardLayoutController;
  renderedIds: readonly string[];
  labelOf: (id: string) => string;
  /** The board's root element; focus is restored to a control inside it. */
  containerRef: RefObject<HTMLElement | null>;
}) {
  const { layout, update } = controller;
  const isDesktop = useMediaQuery("(min-width: 768px)", false);
  const rendered = new Set<string>(renderedIds);
  const orderedIds = layout.columnOrder.filter((id) => rendered.has(id));
  const isDocked = (id: string) => isDesktop && layout.pinnedColumnIds.includes(id);
  const dockedIds = orderedIds.filter(isDocked);
  const scrollerIds = orderedIds.filter((id) => !isDocked(id));
  // The stored active column may be one that isn't rendered: show the first rendered docked one then.
  const activeDockId = layout.activePinnedId && dockedIds.includes(layout.activePinnedId) ? layout.activePinnedId : (dockedIds[0] ?? null);
  const dockOpen = activeDockId !== null && !layout.dockCollapsed;

  // Keyboard users keep their place: after a layout change the control that now represents the column gets focus.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    containerRef.current?.querySelector<HTMLElement>(`[data-column-control="${target}"]`)?.focus();
  }, [layout, containerRef]);

  const changeLayout = useCallback(
    (transition: (current: BoardLayout) => BoardLayout, focus?: string) => {
      if (focus) pendingFocus.current = focus;
      update(transition);
    },
    [update],
  );

  // The active tab of an open dock closes it; any other tab shows its column and opens the dock.
  function selectDockTab(id: string) {
    changeLayout((current) => (dockOpen && id === activeDockId ? collapseDock(current) : setActiveColumn(current, id)), `${id}:tab`);
  }

  function layoutControlsFor(id: string): BoardColumnLayoutControls {
    // A column moves among the columns rendered in its own region (the dock's tabs, or the scroller; everything on narrow screens).
    const scope = { among: (other: string) => rendered.has(other) && (!isDesktop || isDocked(other) === isDocked(id)) };
    const docked = isDocked(id);
    return {
      columnId: id,
      label: labelOf(id),
      pinned: docked,
      pinnable: isDesktop,
      onTogglePin: () => changeLayout((l) => togglePinColumn(l, id), `${id}:pin`),
      canMoveLeft: canMoveColumn(layout, id, "left", scope),
      canMoveRight: canMoveColumn(layout, id, "right", scope),
      onMove: (direction: MoveDirection) => changeLayout((l) => moveColumn(l, id, direction, scope), `${id}:menu`),
      onCollapse: docked ? () => changeLayout(collapseDock, `${id}:tab`) : undefined,
    };
  }

  function dockTabsFor(countOf: (id: string) => number): BoardDockTab[] {
    return dockedIds.map((id) => ({ id, title: labelOf(id), count: countOf(id) }));
  }

  return { isDesktop, orderedIds, dockedIds, scrollerIds, activeDockId, dockOpen, selectDockTab, layoutControlsFor, dockTabsFor };
}
