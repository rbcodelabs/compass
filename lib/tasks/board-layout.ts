/**
 * The Tasks board's column layout: which column ids exist and how they start out.
 * The generic model lives in lib/board-layout.ts; this file only binds it to the Tasks board, the counterpart of
 * lib/solutions/board-layout.ts and lib/discovery/board-layout.ts with the same decisions:
 *
 *  - the layout's `columnOrder` is THE column order. The Tasks board has no Columns popover and never had a stored order,
 *    so there is no legacy order to read.
 *  - pinning applies to the status columns (the board's only grouping).
 *  - nothing is pinned by default and the dock starts collapsed, so the board looks as it did before docking existed.
 *
 * CANCELLED is a column id like the others, but the board only RENDERS it while "Show cancelled" is on. The layout is kept
 * whole either way (a pinned CANCELLED stays pinned while it is hidden); the board just filters hidden ids out of the order
 * it renders, the way the roadmap filters hidden horizons.
 */
import {
  boardLayoutKey,
  parseBoardLayout,
  resolveBoardLayout,
  serializeBoardLayout,
  type BoardLayout,
  type BoardLayoutDefaults,
} from "@/lib/board-layout"
import type { TaskStatus } from "@/lib/types"

/** The statuses that always have a column, in default order. */
export const TASK_BOARD_STATUSES: readonly TaskStatus[] = ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"]

/** Every Tasks board column, in default order. CANCELLED is last and only shown behind the "Show cancelled" toggle. */
export const TASK_BOARD_COLUMN_IDS: readonly string[] = [...TASK_BOARD_STATUSES, "CANCELLED"]

/** Nothing is pinned until someone pins a column. The dock starts collapsed. */
export const TASK_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = { pinned: [], dockCollapsed: true }

/** A stored layout as it may arrive: possibly partial, absent, or in an older shape. */
type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveTaskBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, TASK_BOARD_COLUMN_IDS, TASK_BOARD_LAYOUT_DEFAULTS)
}

export function parseTaskBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, TASK_BOARD_COLUMN_IDS, TASK_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store in a saved view: `undefined` when it is the default. */
export function serializeTaskBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, TASK_BOARD_COLUMN_IDS, TASK_BOARD_LAYOUT_DEFAULTS)
}

/** Comparable identity of a stored (possibly absent or stale) layout. An absent layout and an explicit default have the same key. */
export function taskBoardLayoutKey(stored: StoredLayout): string {
  return boardLayoutKey(resolveTaskBoardLayout(stored))
}
