/**
 * The Agent board's column layout: which column ids exist and how they start out. The generic model lives in
 * lib/board-layout.ts; this file binds it to the Agent board (lib/agent-board.ts) with the same decisions as the other boards:
 *
 *  - the layout's `columnOrder` is THE column order (the default is Geode's order: Working, New, Done, Failed, Ready).
 *  - nothing is pinned by default and the dock starts collapsed.
 *
 * Done, Failed and Ready are only RENDERED while they hold a conversation (lib/agent-board.ts `bucketizeBoard`). The layout is
 * kept whole either way: a pinned Failed stays pinned while it is empty and hidden, and its tab comes back with the first
 * failure. The board filters hidden ids out of the order it renders.
 *
 * The layout is browser-local only (localStorage, one key per workspace): the Agent board has no saved views.
 */
import { BOARD_COLUMN_ORDER } from "@/lib/agent-board"
import { parseBoardLayout, resolveBoardLayout, serializeBoardLayout, type BoardLayout, type BoardLayoutDefaults } from "@/lib/board-layout"

/** Every Agent board column, in default order. */
export const AGENT_BOARD_COLUMN_IDS: readonly string[] = BOARD_COLUMN_ORDER

/** Nothing is pinned until someone pins a column. The dock starts collapsed. */
export const AGENT_BOARD_LAYOUT_DEFAULTS: BoardLayoutDefaults = { pinned: [], dockCollapsed: true }

type StoredLayout = Parameters<typeof resolveBoardLayout>[0]

export function resolveAgentBoardLayout(layout: StoredLayout): BoardLayout {
  return resolveBoardLayout(layout, AGENT_BOARD_COLUMN_IDS, AGENT_BOARD_LAYOUT_DEFAULTS)
}

export function parseAgentBoardLayout(raw: unknown): BoardLayout {
  return parseBoardLayout(raw, AGENT_BOARD_COLUMN_IDS, AGENT_BOARD_LAYOUT_DEFAULTS)
}

/** The layout to store: `undefined` when it is the default. */
export function serializeAgentBoardLayout(layout: BoardLayout): BoardLayout | undefined {
  return serializeBoardLayout(layout, AGENT_BOARD_COLUMN_IDS, AGENT_BOARD_LAYOUT_DEFAULTS)
}
