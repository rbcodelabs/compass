import { describe, expect, it } from "vitest"
import { BOARD_COLUMN_ORDER, bucketizeBoard, type AgentBoardCard } from "@/lib/agent-board"
import { pinColumn } from "@/lib/board-layout"
import {
  AGENT_BOARD_COLUMN_IDS,
  AGENT_BOARD_LAYOUT_DEFAULTS,
  parseAgentBoardLayout,
  resolveAgentBoardLayout,
  serializeAgentBoardLayout,
} from "@/lib/agent/board-layout"

describe("Agent board layout binding", () => {
  it("uses the board's own column order as the default (one source of truth)", () => {
    expect([...AGENT_BOARD_COLUMN_IDS]).toEqual(["working", "new", "done", "failed", "ready"])
    expect([...AGENT_BOARD_COLUMN_IDS]).toEqual([...BOARD_COLUMN_ORDER])
    // bucketizeBoard returns its columns in that same order
    const one = (id: string, runStatus: string | null, messageCount: number, reviewedAt: string | null): AgentBoardCard => ({
      id, title: id, messageCount, runStatus, lastActivityAt: "2026-01-01T00:00:00Z", reviewedAt,
    })
    const columns = bucketizeBoard([
      one("a", "RUNNING", 1, null), one("b", "SUCCEEDED", 1, null), one("c", "SUCCEEDED", 1, "2026-02-01T00:00:00Z"), one("d", "FAILED", 1, null), one("e", null, 0, null),
    ])
    expect(columns.map((c) => c.id)).toEqual([...AGENT_BOARD_COLUMN_IDS])
  })

  it("starts with nothing pinned and the dock collapsed", () => {
    expect(resolveAgentBoardLayout(undefined)).toEqual({ columnOrder: [...AGENT_BOARD_COLUMN_IDS], pinnedColumnIds: [], activePinnedId: null, dockCollapsed: true })
    expect(AGENT_BOARD_LAYOUT_DEFAULTS.pinned).toEqual([])
    expect(serializeAgentBoardLayout(resolveAgentBoardLayout(undefined))).toBeUndefined()
  })

  it("round-trips a pinned layout, including a pinned column that can be empty (failed)", () => {
    const pinned = pinColumn(resolveAgentBoardLayout(undefined), "failed")
    expect(parseAgentBoardLayout(serializeAgentBoardLayout(pinned))).toEqual(pinned)
    expect(pinned.pinnedColumnIds).toEqual(["failed"])
  })

  it("degrades corrupt input to the defaults and drops stale ids", () => {
    for (const bad of [null, "nope", 7, {}, { columnOrder: "x", pinnedColumnIds: [] }]) {
      expect(parseAgentBoardLayout(bad)).toEqual(resolveAgentBoardLayout(undefined))
    }
    const layout = parseAgentBoardLayout({ columnOrder: ["ready", "gone"], pinnedColumnIds: ["gone", "ready"], activePinnedId: "gone" })
    expect(layout.columnOrder).toEqual(["ready", "working", "new", "done", "failed"])
    expect(layout.pinnedColumnIds).toEqual(["ready"])
  })
})
