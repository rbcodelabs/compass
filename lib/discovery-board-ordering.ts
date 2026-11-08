import type { OpportunityStatus } from "@/lib/types"

/**
 * Ordering rules for the Discovery board.
 *
 * The board has exactly one persisted ordering: `Opportunity.sortOrder`, written
 * by drag-to-reorder. "Sort by score" is a *view mode* layered on top of that —
 * it never writes. These helpers are pure so the two modes, and the interaction
 * between them, can be tested without a DOM or a drag simulation.
 */

/** Minimum shape the ordering rules care about. */
export type OrderableCard = {
  id: string
  sortOrder: number
  score?: { normalizedScore: number } | null
}

/** Manual order: the persisted `sortOrder`, ascending. */
export function sortBySortOrder<T extends OrderableCard>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Score view mode: highest normalized score first, unscored opportunities last.
 * Ties (and the whole unscored tail) fall back to the manual `sortOrder` so the
 * view stays stable instead of shuffling between renders.
 */
export function sortByScoreDesc<T extends OrderableCard>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aScore = a.score?.normalizedScore
    const bScore = b.score?.normalizedScore
    const aScored = typeof aScore === "number"
    const bScored = typeof bScore === "number"

    if (aScored && bScored && aScore !== bScore) return bScore - aScore
    if (aScored !== bScored) return aScored ? -1 : 1
    return a.sortOrder - b.sortOrder
  })
}

export function orderCards<T extends OrderableCard>(items: T[], scoreSortActive: boolean): T[] {
  return scoreSortActive ? sortByScoreDesc(items) : sortBySortOrder(items)
}

/**
 * What a drag that just ended should persist, if anything.
 *
 * `kind: "none"` means *write nothing*. The score-sort guard is the first
 * branch on purpose: under score sort the on-screen order is derived from
 * `normalizedScore`, so the drop index is meaningless as a `sortOrder`.
 * Persisting it would silently overwrite the user's manual board order with
 * score ranking — the single highest-risk failure mode of this feature.
 */
export type DragEndPlan =
  | { kind: "none" }
  | { kind: "move"; status: OpportunityStatus }
  | { kind: "reorder"; oldIndex: number; newIndex: number }

export function planDragEnd(params: {
  activeId: string
  overId: string | null
  currentStatus: OpportunityStatus | null
  dragSourceStatus: OpportunityStatus | null
  oldIndex: number
  newIndex: number
  scoreSortActive: boolean
}): DragEndPlan {
  const {
    activeId,
    overId,
    currentStatus,
    dragSourceStatus,
    oldIndex,
    newIndex,
    scoreSortActive,
  } = params

  if (scoreSortActive) return { kind: "none" }
  if (!overId) return { kind: "none" }
  if (!currentStatus) return { kind: "none" }

  if (dragSourceStatus && dragSourceStatus !== currentStatus) {
    return { kind: "move", status: currentStatus }
  }

  if (overId.startsWith("column-") || overId === activeId) return { kind: "none" }
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return { kind: "none" }

  return { kind: "reorder", oldIndex, newIndex }
}

/**
 * The status a drop on a dock TAB means, or null when `overData` (dnd-kit's `over.data.current`) is not a tab.
 *
 * A tab whose column is not the open panel has no rendered column behind it. Moving the dragged card into that column
 * while the drag is still in progress would unmount the dragged card (and its menu) mid-drag and make dnd-kit's item
 * set change again and again, so a tab is never an optimistic drag-over target: the destination is resolved at drag end.
 */
export function dockTabDropStatus<S extends string = OpportunityStatus>(overData: { dockTab?: boolean; status?: string } | undefined | null): S | null {
  return overData?.dockTab && overData.status ? (overData.status as S) : null
}

/**
 * The full order of a column after the cards in `reorderedIds` (which may be a filtered subset of it) were put in a new
 * relative order: the subset keeps the positions it occupied, filled in the new order, and every other card stays where it
 * was. The result is what gets numbered 0..n-1, so ties and gaps in the stored `sortOrder` can no longer undo a reorder.
 * Returns null when `reorderedIds` is not made of distinct members of the column.
 */
export function applySubsetOrder(columnIds: readonly string[], reorderedIds: readonly string[]): string[] | null {
  const members = new Set(columnIds)
  if (new Set(reorderedIds).size !== reorderedIds.length || reorderedIds.some((id) => !members.has(id))) return null
  const subset = new Set(reorderedIds)
  let next = 0
  return columnIds.map((id) => (subset.has(id) ? reorderedIds[next++] : id))
}
