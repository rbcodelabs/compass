/**
 * Column layout for boards: which columns are docked ("pinned") in the ONE dock on the right of the scrolling board,
 * which pinned column the dock is showing, whether the dock is collapsed to its tab rail, and the order columns
 * appear in. Pure (no React, no database) so the board components, the saved-view schema and the tests share one
 * definition.
 *
 * Model (all ids are board column ids, e.g. a horizon or "unscheduled"):
 *   - `columnOrder`      every column in render order. Pinned columns are the dock's tabs, in this same relative order.
 *   - `pinnedColumnIds`  columns docked on the right, outside the horizontal scroller. The dock is a single fixed-width
 *                        slot with one tab per pinned column, so its width never depends on how many are pinned.
 *   - `activePinnedId`   the pinned column the dock panel shows; null only when nothing is pinned.
 *   - `dockCollapsed`    the dock is folded down to its tab rail (the panel is hidden).
 *
 * Two kinds of input exist and are kept apart on purpose:
 *   - STORED / PARSED layouts are untrusted: they may be missing, malformed, stale (an id that no longer exists),
 *     incomplete (an id added since) or in an older shape (per-column `collapsedColumnIds`, which is ignored).
 *     {@link resolveBoardLayout} and {@link parseBoardLayout} turn them into a RESOLVED layout and never throw.
 *   - RESOLVED layouts are what the transition functions ({@link pinColumn}, {@link moveColumn}, ...) take and return.
 *     Each returns the SAME reference when the change is a no-op, so they can be handed straight to a setState updater.
 */
import { z } from "zod"

/** Upper bound on any id list; bounds the stored document. */
export const MAX_LAYOUT_COLUMNS = 50

const columnId = z.string().min(1).max(100)

/**
 * The stored shape. `columnOrder` and `pinnedColumnIds` are required, so `{}` is not a layout. `activePinnedId` and
 * `dockCollapsed` are optional on read (reconciled in resolve). Unknown keys, such as the earlier `collapsedColumnIds`,
 * are stripped.
 */
export const boardLayoutSchema = z.object({
  columnOrder: z.array(columnId).max(MAX_LAYOUT_COLUMNS),
  pinnedColumnIds: z.array(columnId).max(MAX_LAYOUT_COLUMNS),
  activePinnedId: columnId.nullable().optional(),
  dockCollapsed: z.boolean().optional(),
})

/** A RESOLVED layout (always complete). */
export type BoardLayout = {
  columnOrder: string[]
  pinnedColumnIds: string[]
  activePinnedId: string | null
  dockCollapsed: boolean
}

/** Which columns a board pins, and how the dock starts, before anyone touches the layout. Order is the caller's `knownIds` order. */
export type BoardLayoutDefaults = {
  pinned?: readonly string[]
  /** Which default-pinned column the dock shows. Falls back to the first pinned column. */
  active?: string | null
  /** Defaults to true: the dock starts as a slim tab rail. */
  dockCollapsed?: boolean
}

export type MoveDirection = "left" | "right"

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/** The pinned columns in dock-tab order (their relative order in `columnOrder`). */
export function pinnedTabOrder(layout: Pick<BoardLayout, "columnOrder" | "pinnedColumnIds">): string[] {
  return layout.columnOrder.filter((id) => layout.pinnedColumnIds.includes(id))
}

/**
 * Turns a stored layout (or nothing) into a resolved one for the columns that exist now.
 *   - unknown ids are dropped everywhere;
 *   - ids the layout never mentioned are appended to the order, and take their default pin state;
 *   - the active column must be pinned, else it is the first pinned column (null when nothing is pinned);
 *   - `dockCollapsed` defaults to the defaults' value (true), and is true when nothing is pinned.
 * With no layout the result is the defaults.
 */
export function resolveBoardLayout(
  layout: Partial<z.infer<typeof boardLayoutSchema>> | null | undefined,
  knownIds: readonly string[],
  defaults: BoardLayoutDefaults = {},
): BoardLayout {
  const known = new Set(knownIds)
  const defaultPinned = dedupe(defaults.pinned ?? []).filter((id) => known.has(id))
  const defaultCollapsed = defaults.dockCollapsed ?? true

  let columnOrder: string[]
  let pinned: string[]
  let preferredActive: string | null | undefined
  let collapsed: boolean

  if (!layout) {
    columnOrder = dedupe(knownIds)
    pinned = defaultPinned
    preferredActive = defaults.active
    collapsed = defaultCollapsed
  } else {
    const mentioned = new Set(layout.columnOrder ?? [])
    const savedOrder = dedupe(layout.columnOrder ?? []).filter((id) => known.has(id))
    const savedOrderSet = new Set(savedOrder)
    const newIds = dedupe(knownIds).filter((id) => !savedOrderSet.has(id))
    columnOrder = [...savedOrder, ...newIds]
    // A column the layout has never heard of is "new": it takes its default placement rather than being forced unpinned.
    const brandNew = newIds.filter((id) => !mentioned.has(id))
    pinned = dedupe([
      ...(layout.pinnedColumnIds ?? []).filter((id) => known.has(id)),
      ...brandNew.filter((id) => defaultPinned.includes(id)),
    ])
    preferredActive = layout.activePinnedId
    collapsed = layout.dockCollapsed ?? defaultCollapsed
  }

  const tabs = columnOrder.filter((id) => pinned.includes(id))
  const activePinnedId = preferredActive && tabs.includes(preferredActive) ? preferredActive : (tabs[0] ?? null)
  return { columnOrder, pinnedColumnIds: pinned, activePinnedId, dockCollapsed: activePinnedId === null ? true : collapsed }
}

/** Tolerant parse of untrusted input (stored JSON, localStorage). Anything that isn't a layout degrades to the defaults. */
export function parseBoardLayout(raw: unknown, knownIds: readonly string[], defaults: BoardLayoutDefaults = {}): BoardLayout {
  const parsed = boardLayoutSchema.safeParse(raw)
  return resolveBoardLayout(parsed.success ? parsed.data : undefined, knownIds, defaults)
}

/** Stable identity of a resolved layout (the pinned set is order-insensitive; column order is not). */
export function boardLayoutKey(layout: z.infer<typeof boardLayoutSchema>): string {
  return JSON.stringify([layout.columnOrder, [...layout.pinnedColumnIds].sort(), layout.activePinnedId ?? null, layout.dockCollapsed ?? null])
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

/** Dock a column. It becomes the active tab and the dock opens, so the user sees what they just pinned. */
export function pinColumn(layout: BoardLayout, id: string): BoardLayout {
  if (!layout.columnOrder.includes(id) || isPinned(layout, id)) return layout
  return { ...layout, pinnedColumnIds: [...layout.pinnedColumnIds, id], activePinnedId: id, dockCollapsed: false }
}

/**
 * Return a column to the scroller. If it was the active tab, its neighbour (the next tab, else the previous) takes
 * over; when nothing stays pinned there is no dock at all.
 */
export function unpinColumn(layout: BoardLayout, id: string): BoardLayout {
  if (!isPinned(layout, id)) return layout
  const tabs = pinnedTabOrder(layout)
  const index = tabs.indexOf(id)
  const pinnedColumnIds = layout.pinnedColumnIds.filter((x) => x !== id)
  if (pinnedColumnIds.length === 0) return { ...layout, pinnedColumnIds, activePinnedId: null, dockCollapsed: true }
  const activePinnedId = layout.activePinnedId === id ? (tabs[index + 1] ?? tabs[index - 1]) : layout.activePinnedId
  return { ...layout, pinnedColumnIds, activePinnedId }
}

export function togglePinColumn(layout: BoardLayout, id: string): BoardLayout {
  return isPinned(layout, id) ? unpinColumn(layout, id) : pinColumn(layout, id)
}

/** Show a pinned column in the dock and open the dock. A column that isn't pinned is a no-op. */
export function setActiveColumn(layout: BoardLayout, id: string): BoardLayout {
  if (!isPinned(layout, id) || (layout.activePinnedId === id && !layout.dockCollapsed)) return layout
  return { ...layout, activePinnedId: id, dockCollapsed: false }
}

export function collapseDock(layout: BoardLayout): BoardLayout {
  return layout.dockCollapsed ? layout : { ...layout, dockCollapsed: true }
}

/** Open the dock on its active column. Nothing to open when nothing is pinned. */
export function expandDock(layout: BoardLayout): BoardLayout {
  return layout.dockCollapsed && layout.activePinnedId !== null ? { ...layout, dockCollapsed: false } : layout
}

/**
 * What clicking a tab does: the active tab of an open dock closes it; any other tab (or the active tab of a
 * collapsed dock) shows that column and opens the dock.
 */
export function selectDockTab(layout: BoardLayout, id: string): BoardLayout {
  if (!isPinned(layout, id)) return layout
  return layout.activePinnedId === id && !layout.dockCollapsed ? collapseDock(layout) : setActiveColumn(layout, id)
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
