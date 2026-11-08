/**
 * The Solutions status board's column layout: which column ids exist and how they start out.
 * The generic model lives in lib/board-layout.ts; this file only binds it to the Solutions board.
 *
 * Unification with the Columns popover (see lib/saved-views/solutions-state.ts): the layout's `columnOrder` is THE column
 * order. The popover keeps hide/show (`columns.status.hidden`) but reads and writes order here. A saved view written
 * before layouts existed only has `columns.status.order`; {@link legacyOrderToLayout} turns that into a starting layout so
 * such views keep their order with no data migration.
 */
import {
  boardLayoutKey,
  parseBoardLayout,
  resolveBoardLayout,
  serializeBoardLayout,
  type BoardLayout,
  type BoardLayoutDefaults,
} from "@/lib/board-layout"
import { DEFAULT_SOLUTION_COLUMN_ORDER } from "@/lib/saved-views/columns"

/** Every Solutions status column, in default order (work in flight first). */
export const SOLUTION_BOARD_COLUMN_IDS: readonly string[] = DEFAULT_SOLUTION_COLUMN_ORDER

/**
 * Nothing is pinned until someone pins a column, so the board looks exactly as it did before docking existed.
 * (SHIPPED and KILLED are the natural candidates, but they are not defaults.) The dock starts collapsed.
 */
export const SOLUTION_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = { pinned: [], dockCollapsed: true }

/** A stored layout as it may arrive: possibly partial, absent, or in an older shape. */
type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveSolutionBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, SOLUTION_BOARD_COLUMN_IDS, SOLUTION_BOARD_LAYOUT_DEFAULTS)
}

export function parseSolutionBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, SOLUTION_BOARD_COLUMN_IDS, SOLUTION_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store in a saved view: `undefined` when it is the default. */
export function serializeSolutionBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, SOLUTION_BOARD_COLUMN_IDS, SOLUTION_BOARD_LAYOUT_DEFAULTS)
}

/** Comparable identity of a stored (possibly absent or stale) layout. An absent layout and an explicit default have the same key. */
export function solutionBoardLayoutKey(stored: StoredLayout): string {
  return boardLayoutKey(resolveSolutionBoardLayout(stored))
}

/**
 * Read-time compatibility with the popover's old `columns.status.order` (a saved view, or an `?order=` URL). An absent or
 * empty order has no opinion, so the result is `undefined`; otherwise it is the layout that order describes: that order
 * (statuses it omits follow in default order), nothing pinned. Unknown statuses are dropped.
 */
export function legacyOrderToLayout(order: readonly string[] | undefined): BoardLayout | undefined {
  if (!order || order.length === 0) return undefined
  return resolveSolutionBoardLayout({ columnOrder: [...order], pinnedColumnIds: [] })
}

/**
 * The layout a stored display document means: its `columnLayout` when it has one, else the layout its legacy
 * `columns.status.order` describes, else `undefined` (the default).
 */
export function effectiveStoredLayout(display: {
  columnLayout?: StoredLayout
  columns?: { status?: { order?: readonly string[] } }
}): StoredLayout {
  return display.columnLayout ?? legacyOrderToLayout(display.columns?.status?.order)
}
