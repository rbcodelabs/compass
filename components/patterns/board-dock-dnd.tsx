"use client";

import type { ReactNode } from "react";
import { closestCenter, pointerWithin, useDroppable, type CollisionDetection } from "@dnd-kit/core";
import { cn } from "@/lib/utils";

/**
 * Drag and drop for a board's pinned-column dock (see board-pinned.tsx): the dock's tabs are drop targets.
 * Shared by every status board that has a dock (Solutions, Opportunities), so they behave identically.
 */

/**
 * A tab only counts as a drop target when the pointer is actually on it: closestCenter alone lets a tall column body beat
 * a small tab, because it measures the dragged card's centre rather than the pointer. Anything else falls back to
 * closestCenter, which is what the boards used before they had a dock (so in-column ordering is unchanged).
 */
export const dockAwareCollisionDetection: CollisionDetection = (args) => {
  const onTab = pointerWithin(args).find((hit) => args.droppableContainers.find((c) => c.id === hit.id)?.data.current?.dockTab);
  return onTab ? [onTab] : closestCenter(args);
};

/**
 * A dock tab, which is also a drop target: a card dropped on it lands in that column exactly as a drop on the open column
 * would, so it registers under the column's own droppable id (`columnDroppableId`, e.g. `column-<status>`) with
 * `{ status: columnId }` data, which the board's drag handlers already parse. While that column is the open panel the
 * panel owns that id (two droppables must not share one), so the tab is disabled and parked under an id nothing refers
 * to; the wrapper element stays put so the tab keeps focus.
 */
export function DroppableDockTab({
  columnId,
  columnDroppableId,
  panelOpen,
  slot,
  children,
}: {
  columnId: string;
  columnDroppableId: string;
  panelOpen: boolean;
  /** The `data-slot` of the wrapper (tests and e2e find the tabs' drop wrappers by it). */
  slot: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: panelOpen ? `dock-tab-${columnId}` : columnDroppableId,
    data: { status: columnId, dockTab: true },
    disabled: panelOpen,
  });
  return (
    <div ref={setNodeRef} data-slot={slot} data-status={columnId} className={cn("h-fit rounded-xl", isOver && "ring-2 ring-ring/40")}>
      {children}
    </div>
  );
}
