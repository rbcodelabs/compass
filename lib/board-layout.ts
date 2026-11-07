/**
 * Column layout for boards: which columns are docked ("pinned") on the right of the
 * scrolling board, in which order columns appear, and which pinned columns are
 * collapsed to a slim tab. Pure (no React, no database) so the board components, the
 * saved-view schema and the tests share one definition.
 *
 * Model (all ids are board column ids, e.g. a horizon or "unscheduled"):
 *   - `columnOrder`         every column in render order. Pinned columns render in the
 *                           pinned region in this same relative order.
 *   - `pinnedColumnIds`     columns docked on the right, outside the horizontal scroller.
 *   - `collapsedColumnIds`  the subset of pinned columns folded down to a tab. Only a
 *                           pinned column can be collapsed; unpinning clears the flag.
 *
 * Two kinds of input exist and are kept apart on purpose:
 *   - STORED / PARSED layouts are untrusted: they may be missing, malformed, stale (an id
 *     that no longer exists) or incomplete (an id added since). {@link resolveBoardLayout}
 *     and {@link parseBoardLayout} turn them into a RESOLVED layout, dropping unknown ids
 *     and appending new ones, and never throw.
 *   - RESOLVED layouts are what the transition functions ({@link pinColumn},
 *     {@link moveColumn}, ...) take and return. Each returns the SAME reference when the
 *     change is a no-op, so they can be handed straight to a setState updater.
 */
import { z } from "zod"

/** Upper bound on any id list; bounds the stored document. */
export const MAX_LAYOUT_COLUMNS = 50

const columnId = z.string().min(1).max(100)

/** The stored shape. `collapsedColumnIds` is optional on read; the other two are required, so `{}` is not a layout. */
export const boardLayoutSchema = z.object({
  columnOrder: z.array(columnId).max(MAX_LAYOUT_COLUMNS),
  pinnedColumnIds: z.array(columnId).max(MAX_LAYOUT_COLUMNS),
  collapsedColumnIds: z.array(columnId).max(MAX_LAYOUT_COLUMNS).default([]),
})

export type BoardLayout = z.infer<typeof boardLayoutSchema>

/** Which columns a board pins/collapses before anyone touches the layout. Order is always the caller's `knownIds` order. */
export type BoardLayoutDefaults = {
  pinned?: readonly string[]
  /** Only meaningful for columns that are also pinned. */
  collapsed?: readonly string[]
}

export type MoveDirection = "left" | "right"

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/**
 * Turns a stored layout (or nothing) into a resolved one for the columns that exist now.
 *   - unknown ids are dropped everywhere;
 *   - ids the layout never mentioned are appended to the order, and take their default pin/collapse state;
 *   - collapsed is clamped to pinned.
 * With no layout the result is the defaults.
 */
export function resolveBoardLayout(
  layout: Partial<BoardLayout> | null | undefined,
  knownIds: readonly string[],
  defaults: BoardLayoutDefaults = {},
): BoardLayout {
  const known = new Set(knownIds)
  const defaultPinned = dedupe(defaults.pinned ?? []).filter((id) => known.has(id))
  const defaultCollapsed = new Set((defaults.collapsed ?? []).filter((id) => known.has(id)))

  if (!layout) {
    return {
      columnOrder: dedupe(knownIds),
      pinnedColumnIds: defaultPinned,
      collapsedColumnIds: defaultPinned.filter((id) => defaultCollapsed.has(id)),
    }
  }

  const mentioned = new Set(layout.columnOrder ?? [])
  const savedOrder = dedupe(layout.columnOrder ?? []).filter((id) => known.has(id))
  const savedOrderSet = new Set(savedOrder)
  const newIds = dedupe(knownIds).filter((id) => !savedOrderSet.has(id))
  const columnOrder = [...savedOrder, ...newIds]

  // A column the layout has never heard of is "new": it takes its default placement rather than being forced unpinned.
  const brandNew = newIds.filter((id) => !mentioned.has(id))
  const pinned = dedupe([
    ...(layout.pinnedColumnIds ?? []).filter((id) => known.has(id)),
    ...brandNew.filter((id) => defaultPinned.includes(id)),
  ])
  const pinnedSet = new Set(pinned)
  const collapsed = dedupe([
    ...(layout.collapsedColumnIds ?? []).filter((id) => pinnedSet.has(id)),
    ...brandNew.filter((id) => pinnedSet.has(id) && defaultCollapsed.has(id)),
  ])

  return { columnOrder, pinnedColumnIds: pinned, collapsedColumnIds: collapsed }
}

/** Tolerant parse of untrusted input (stored JSON, localStorage). Anything that isn't a layout degrades to the defaults. */
export function parseBoardLayout(raw: unknown, knownIds: readonly string[], defaults: BoardLayoutDefaults = {}): BoardLayout {
  const parsed = boardLayoutSchema.safeParse(raw)
  return resolveBoardLayout(parsed.success ? parsed.data : undefined, knownIds, defaults)
}

/** Stable identity of a resolved layout (pin/collapse sets are order-insensitive; column order is not). */
export function boardLayoutKey(layout: BoardLayout): string {
  return JSON.stringify([layout.columnOrder, [...layout.pinnedColumnIds].sort(), [...layout.collapsedColumnIds].sort()])
}

export function isDefaultBoardLayout(layout: BoardLayout, knownIds: readonly string[], defaults: BoardLayoutDefaults = {}): boolean {
  const resolved = resolveBoardLayout(layout, knownIds, defaults)
  return boardLayoutKey(resolved) === boardLayoutKey(resolveBoardLayout(undefined, knownIds, defaults))
}

/**
 * The form to store: `undefined` when the layout is the default, so an untouched board adds nothing to a saved view
 * and a view saved before this feature existed compares equal to an untouched board.
 */
export function serializeBoardLayout(layout: BoardLayout, knownIds: readonly string[], defaults: BoardLayoutDefaults = {}): BoardLayout | undefined {
  const resolved = resolveBoardLayout(layout, knownIds, defaults)
  return isDefaultBoardLayout(resolved, knownIds, defaults) ? undefined : resolved
}

export function isPinned(layout: BoardLayout, id: string): boolean {
  return layout.pinnedColumnIds.includes(id)
}

export function isCollapsed(layout: BoardLayout, id: string): boolean {
  return layout.collapsedColumnIds.includes(id)
}

/** Dock a column on the right. Stays where it is in `columnOrder`, so it keeps its place among the pinned columns by that order. */
export function pinColumn(layout: BoardLayout, id: string): BoardLayout {
  if (!layout.columnOrder.includes(id) || isPinned(layout, id)) return layout
  return { ...layout, pinnedColumnIds: [...layout.pinnedColumnIds, id] }
}

/** Return a column to the scroller. Clears its collapsed flag. */
export function unpinColumn(layout: BoardLayout, id: string): BoardLayout {
  if (!isPinned(layout, id)) return layout
  return {
    ...layout,
    pinnedColumnIds: layout.pinnedColumnIds.filter((x) => x !== id),
    collapsedColumnIds: layout.collapsedColumnIds.filter((x) => x !== id),
  }
}

export function togglePinColumn(layout: BoardLayout, id: string): BoardLayout {
  return isPinned(layout, id) ? unpinColumn(layout, id) : pinColumn(layout, id)
}

/** Collapse or expand a pinned column. A column that isn't pinned can't be collapsed (no-op). */
export function setColumnCollapsed(layout: BoardLayout, id: string, collapsed: boolean): BoardLayout {
  if (!isPinned(layout, id) || isCollapsed(layout, id) === collapsed) return layout
  return {
    ...layout,
    collapsedColumnIds: collapsed ? [...layout.collapsedColumnIds, id] : layout.collapsedColumnIds.filter((x) => x !== id),
  }
}

export function toggleColumnCollapsed(layout: BoardLayout, id: string): BoardLayout {
  return setColumnCollapsed(layout, id, !isCollapsed(layout, id))
}

/**
 * Which columns take part in a move: the ones rendered in the same region as `id`. `among` lets the caller
 * exclude columns that aren't rendered (a hidden horizon) or choose the region (pinned vs scroller, or "all"
 * on narrow screens where pinning is ignored). Defaults to the columns sharing `id`'s pinned state.
 */
export type MoveScope = { among?: (columnId: string) => boolean }

function regionOf(layout: BoardLayout, id: string, scope: MoveScope | undefined): string[] {
  const among = scope?.among ?? ((other: string) => isPinned(layout, other) === isPinned(layout, id))
  return layout.columnOrder.filter((other) => other === id || among(other))
}

export function canMoveColumn(layout: BoardLayout, id: string, direction: MoveDirection, scope?: MoveScope): boolean {
  if (!layout.columnOrder.includes(id)) return false
  const region = regionOf(layout, id, scope)
  const index = region.indexOf(id)
  return direction === "left" ? index > 0 : index < region.length - 1
}

/** Swap a column with its neighbour in the same region. Columns outside the region keep their slots. */
export function moveColumn(layout: BoardLayout, id: string, direction: MoveDirection, scope?: MoveScope): BoardLayout {
  if (!canMoveColumn(layout, id, direction, scope)) return layout
  const region = regionOf(layout, id, scope)
  const neighbour = region[region.indexOf(id) + (direction === "left" ? -1 : 1)]
  const order = [...layout.columnOrder]
  const a = order.indexOf(id)
  const b = order.indexOf(neighbour)
  ;[order[a], order[b]] = [order[b], order[a]]
  return { ...layout, columnOrder: order }
}

/** Place `id` where `overId` is within the same region (the drag-to-reorder primitive). */
export function reorderColumn(layout: BoardLayout, id: string, overId: string, scope?: MoveScope): BoardLayout {
  if (id === overId) return layout
  const region = regionOf(layout, id, scope)
  if (!region.includes(overId)) return layout
  const reordered = [...region]
  reordered.splice(reordered.indexOf(id), 1)
  reordered.splice(reordered.indexOf(overId) + (region.indexOf(id) < region.indexOf(overId) ? 1 : 0), 0, id)
  // Write the region back into the slots it occupied; everything else stays put.
  const slots = new Set(region)
  let next = 0
  const order = layout.columnOrder.map((existing) => (slots.has(existing) ? reordered[next++] : existing))
  return order.every((value, i) => value === layout.columnOrder[i]) ? layout : { ...layout, columnOrder: order }
}
