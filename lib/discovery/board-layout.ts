/**
 * The Opportunities (Discovery) status board's column layout: which column ids exist and how they start out.
 * The generic model lives in lib/board-layout.ts; this file only binds it to the Opportunities board. It is the
 * counterpart of lib/solutions/board-layout.ts, with the same decisions:
 *
 *  - the layout's `columnOrder` is THE column order. The Columns popover keeps hide/show (`columns.status.hidden`) but reads
 *    and writes order here. A saved view written before layouts existed only has `columns.status.order`;
 *    {@link legacyOrderToLayout} turns that into a starting layout, so such views keep their order with no data migration.
 *  - pinning applies to the STATUS grouping only. The custom-field board and every other grouping ignore it.
 *  - nothing is pinned by default and the dock starts collapsed.
 */
import {
  boardLayoutKey,
  parseBoardLayout,
  resolveBoardLayout,
  serializeBoardLayout,
  type BoardLayout,
  type BoardLayoutDefaults,
} from "@/lib/board-layout"
import { OPPORTUNITY_PIPELINE_STATUSES } from "@/lib/opportunity-status"
import { DEFAULT_OPPORTUNITY_COLUMN_ORDER } from "@/lib/saved-views/columns"

/**
 * Every Opportunities status column, in default order. The SET of columns is the shared status definitions' board columns
 * (lib/opportunity-status.ts: every status but ARCHIVED, so UNREVIEWED is one and a future status will be too); the default
 * ORDER is the board's own (lib/saved-views/columns.ts: Active first, the Unreviewed inbox last). A status the default order
 * does not place yet is appended in definition order, so adding a status never needs this file to change. A stored layout
 * that predates a status resolves with that status appended (lib/board-layout.ts: ids a layout never mentioned follow the order).
 */
export const OPPORTUNITY_BOARD_COLUMN_IDS: readonly string[] = [
  ...DEFAULT_OPPORTUNITY_COLUMN_ORDER.filter((status) => OPPORTUNITY_PIPELINE_STATUSES.includes(status)),
  ...OPPORTUNITY_PIPELINE_STATUSES.filter((status) => !DEFAULT_OPPORTUNITY_COLUMN_ORDER.includes(status as never)),
]

/** Nothing is pinned until someone pins a column, so the board looks exactly as it did before docking existed. The dock starts collapsed. */
export const OPPORTUNITY_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = { pinned: [], dockCollapsed: true }

/** A stored layout as it may arrive: possibly partial, absent, or in an older shape. */
type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveOpportunityBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, OPPORTUNITY_BOARD_COLUMN_IDS, OPPORTUNITY_BOARD_LAYOUT_DEFAULTS)
}

export function parseOpportunityBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, OPPORTUNITY_BOARD_COLUMN_IDS, OPPORTUNITY_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store in a saved view: `undefined` when it is the default. */
export function serializeOpportunityBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, OPPORTUNITY_BOARD_COLUMN_IDS, OPPORTUNITY_BOARD_LAYOUT_DEFAULTS)
}

/** Comparable identity of a stored (possibly absent or stale) layout. An absent layout and an explicit default have the same key. */
export function opportunityBoardLayoutKey(stored: StoredLayout): string {
  return boardLayoutKey(resolveOpportunityBoardLayout(stored))
}

/**
 * Read-time compatibility with the popover's old `columns.status.order` (a saved view, or an `?order=` URL). An absent or
 * empty order has no opinion, so the result is `undefined`; otherwise it is the layout that order describes: that order
 * (statuses it omits follow in default order), nothing pinned. Unknown statuses are dropped.
 */
export function legacyOrderToLayout(order: readonly string[] | undefined): BoardLayout | undefined {
  if (!order || order.length === 0) return undefined
  return resolveOpportunityBoardLayout({ columnOrder: [...order], pinnedColumnIds: [] })
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
