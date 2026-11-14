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
    expect([...AGENT_BOARD_COLUMN_IDS]).toEqual(["working", "awaiting", "waiting", "new", "done", "failed", "ready"])
    expect([...AGENT_BOARD_COLUMN_IDS]).toEqual([...BOARD_COLUMN_ORDER])
    // bucketizeBoard returns its columns in that same order when all columns are populated
    const one = (id: string, overrides: Partial<AgentBoardCard>): AgentBoardCard => ({
      id,
      title: id,
      messageCount: 1,
      runStatus: "SUCCEEDED",
      lastActivityAt: "2026-01-01T00:00:00Z",
      reviewedAt: null,
      ...overrides,
    })
    const columns = bucketizeBoard([
      one("a", { runStatus: "RUNNING" }),
      one("b", { runStatus: "RUNNING", substatus: "AWAITING_QUESTION" }),
      one("c", {
        scheduledWakeup: { id: "w1", fireAt: "2026-01-01T00:05:00Z", delaySeconds: 300, reason: null, prompt: "p" },
      }),
      one("d", { runStatus: "SUCCEEDED" }),
      one("e", { runStatus: "SUCCEEDED", reviewedAt: "2026-02-01T00:00:00Z" }),
      one("f", { runStatus: "FAILED" }),
      one("g", { runStatus: null, messageCount: 0 }),
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
    expect(layout.columnOrder).toEqual(["ready", "working", "awaiting", "waiting", "new", "done", "failed"])
    expect(layout.pinnedColumnIds).toEqual(["ready"])
  })
})
