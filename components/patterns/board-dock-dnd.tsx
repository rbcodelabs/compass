"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { closestCenter, pointerWithin, useDroppable, type CollisionDetection, type UniqueIdentifier } from "@dnd-kit/core";
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

/**
 * Collision detection that cannot ping-pong. A board that moves the dragged card into the column it is over (an optimistic
 * cross-column move) REMOUNTS the card in a different parent; dnd-kit then re-measures the dragged node at its new
 * position, which can make the next collision pass pick the column it just left, which moves the card back, and so on.
 * With nothing but React state in the loop that cycle runs synchronously (effect, state, render, effect...) until React
 * gives up with "Maximum update depth exceeded". It is geometry dependent, hence intermittent: it showed up when a pinned
 * dock had scrolled the board so a target column was partly off screen.
 *
 * dnd-kit's own multiple-containers recipe breaks the cycle and so does this: after the board reports that it moved the card
 * (`noteMoved`), collisions return the last result unchanged for the next couple of animation frames, so the new geometry is
 * measured before the next decision and a flip back needs a real pointer movement. Call `reset` when a drag ends.
 */
export function useStableBoardCollision(base: CollisionDetection = dockAwareCollisionDetection) {
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const frozen = useRef(false);
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (frozen.current && lastOverId.current !== null) return [{ id: lastOverId.current }];
      const hits = base(args);
      if (hits.length > 0) lastOverId.current = hits[0].id;
      return hits;
    },
    [base],
  );
  const noteMoved = useCallback(() => {
    frozen.current = true;
    if (typeof requestAnimationFrame !== "function") {
      frozen.current = false;
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => { frozen.current = false; }));
  }, []);
  const reset = useCallback(() => {
    frozen.current = false;
    lastOverId.current = null;
  }, []);
  return { collisionDetection, noteMoved, reset };
}
