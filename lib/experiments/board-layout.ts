/**
 * The Experiments board's column layout: which column ids exist and how they start out. The generic model lives in
 * lib/board-layout.ts; this file only binds it to the Experiments board, the counterpart of lib/tasks/board-layout.ts with
 * the same decisions:
 *
 *  - the layout's `columnOrder` is THE column order (the board never had a stored order, so there is no legacy order).
 *  - pinning applies to the status columns, the board's only grouping.
 *  - nothing is pinned by default and the dock starts collapsed, so the board looks as it did before docking existed.
 *
 * The layout is browser-local only (localStorage, one key per workspace): Experiments has no saved views.
 */
import { parseBoardLayout, resolveBoardLayout, serializeBoardLayout, type BoardLayout, type BoardLayoutDefaults } from "@/lib/board-layout"
import type { ExperimentStatus } from "@/lib/types"

/** Every Experiments board column, in default order. */
export const EXPERIMENT_BOARD_STATUSES: readonly ExperimentStatus[] = ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"]

/** Nothing is pinned until someone pins a column. The dock starts collapsed. */
export const EXPERIMENT_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = { pinned: [], dockCollapsed: true }

type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveExperimentBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, EXPERIMENT_BOARD_STATUSES, EXPERIMENT_BOARD_LAYOUT_DEFAULTS)
}

export function parseExperimentBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, EXPERIMENT_BOARD_STATUSES, EXPERIMENT_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store: `undefined` when it is the default. */
export function serializeExperimentBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, EXPERIMENT_BOARD_STATUSES, EXPERIMENT_BOARD_LAYOUT_DEFAULTS)
}
