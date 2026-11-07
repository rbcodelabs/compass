/**
 * The workspace roadmap board's column layout: which column ids exist and how they start out.
 * The generic model lives in lib/board-layout.ts; this file only binds it to the roadmap.
 */
import {
  boardLayoutKey,
  parseBoardLayout,
  resolveBoardLayout,
  serializeBoardLayout,
  type BoardLayout,
  type BoardLayoutDefaults,
} from "@/lib/board-layout"
import { INTERNAL_BOARD_HORIZONS } from "@/lib/roadmap"

/** The "Not scheduled" candidates column: an ordinary column that happens to default to pinned. */
export const UNSCHEDULED_COLUMN_ID = "unscheduled"

/**
 * Every column the roadmap board can show, in default order. Launch horizons are included even when the
 * launch workflow is off, so a layout keeps their slots; the board just doesn't render what isn't visible.
 */
export const ROADMAP_BOARD_COLUMN_IDS: readonly string[] = [...INTERNAL_BOARD_HORIZONS, UNSCHEDULED_COLUMN_ID]

/**
 * Pinned, with the dock collapsed to its slim tab rail, which is how the "Not scheduled" pane has always started, so a
 * workspace that never touches the layout sees no change on desktop.
 */
export const ROADMAP_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = {
  pinned: [UNSCHEDULED_COLUMN_ID],
  active: UNSCHEDULED_COLUMN_ID,
  dockCollapsed: true,
}

/** A stored layout as it may arrive: possibly partial, absent, or in an older shape. */
type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveRoadmapBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, ROADMAP_BOARD_COLUMN_IDS, ROADMAP_BOARD_LAYOUT_DEFAULTS)
}

export function parseRoadmapBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, ROADMAP_BOARD_COLUMN_IDS, ROADMAP_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store in a saved view: `undefined` when it is the default. */
export function serializeRoadmapBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, ROADMAP_BOARD_COLUMN_IDS, ROADMAP_BOARD_LAYOUT_DEFAULTS)
}

/**
 * Comparable identity of a stored (possibly absent or stale) layout, for "is this view modified?".
 * An absent layout and an explicit default layout have the same key.
 */
export function roadmapBoardLayoutKey(stored: StoredLayout): string {
  return boardLayoutKey(resolveRoadmapBoardLayout(stored))
}
