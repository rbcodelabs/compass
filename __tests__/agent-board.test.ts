/**
 * The agent board's bucketing: which column a conversation lands in, how a column is
 * ordered, and which columns are shown. Pure, so no database is involved.
 */
import { describe, expect, it } from "vitest"

import {
  BOARD_COLUMN_LABELS,
  bucketizeBoard,
  classifyBoardCard,
  formatRelativeTime,
  type AgentBoardCard,
} from "@/lib/agent-board"

const T0 = "2026-10-05T12:00:00.000Z"
const T1 = "2026-10-05T12:05:00.000Z"
const T2 = "2026-10-05T12:10:00.000Z"

function card(overrides: Partial<AgentBoardCard> = {}): AgentBoardCard {
  return {
    id: "c-1",
    title: "A chat",
    messageCount: 2,
    runStatus: "SUCCEEDED",
    lastActivityAt: T1,
    reviewedAt: null,
    ...overrides,
  }
}

describe("classifyBoardCard", () => {
  it.each(["QUEUED", "RUNNING"])("puts a %s run in Working", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("working")
  })

  it.each(["FAILED", "INTERRUPTED"])("puts a %s run in Failed", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("failed")
  })

  it("keeps a failed run in Failed even if the user has reviewed it (a new turn is what clears it)", () => {
    expect(classifyBoardCard(card({ runStatus: "FAILED", reviewedAt: T2 }))).toBe("failed")
  })

  it("lets a running run outrank everything else, including an old review", () => {
    expect(classifyBoardCard(card({ runStatus: "RUNNING", reviewedAt: T2 }))).toBe("working")
  })

  it.each(["SUCCEEDED", "CANCELED", null])("treats a %s latest run as idle", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("new")
  })

  it("is New when idle with messages and never reviewed", () => {
    expect(classifyBoardCard(card({ reviewedAt: null }))).toBe("new")
  })

  it("is Done when reviewed after the last activity", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T1, reviewedAt: T2 }))).toBe("done")
  })

  it("is Done when reviewed at exactly the last activity instant", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T1, reviewedAt: T1 }))).toBe("done")
  })

  it("becomes New again when activity lands after the review", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T2, reviewedAt: T1 }))).toBe("new")
  })

  it("is Ready when there are no messages, whatever the review says", () => {
    expect(classifyBoardCard(card({ messageCount: 0, runStatus: null, reviewedAt: T2 }))).toBe("ready")
  })

  it("treats an unparseable timestamp as unreviewed rather than throwing", () => {
    expect(classifyBoardCard(card({ reviewedAt: "not-a-date" }))).toBe("new")
  })
})

describe("bucketizeBoard", () => {
  it("always shows Working and New, even when empty, and hides every other empty column", () => {
    const columns = bucketizeBoard([])
    expect(columns.map((c) => c.id)).toEqual(["working", "new"])
    expect(columns.every((c) => c.cards.length === 0)).toBe(true)
  })

  it("shows a non-core column only once it has a card, in Geode's column order", () => {
    const columns = bucketizeBoard([
      card({ id: "ready", messageCount: 0, runStatus: null }),
      card({ id: "failed", runStatus: "FAILED" }),
      card({ id: "done", reviewedAt: T2 }),
    ])
    expect(columns.map((c) => c.id)).toEqual(["working", "new", "done", "failed", "ready"])
    expect(columns.map((c) => c.label)).toEqual(["Working", "New", "Done", "Failed", "Ready"])
  })

  it("sorts each column most-recent activity first", () => {
    const columns = bucketizeBoard([
      card({ id: "old", lastActivityAt: T0 }),
      card({ id: "newest", lastActivityAt: T2 }),
      card({ id: "mid", lastActivityAt: T1 }),
    ])
    expect(columns.find((c) => c.id === "new")?.cards.map((c) => c.id)).toEqual(["newest", "mid", "old"])
  })

  it("does not mutate the input array", () => {
    const input = [card({ id: "a", lastActivityAt: T0 }), card({ id: "b", lastActivityAt: T2 })]
    bucketizeBoard(input)
    expect(input.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("exposes a label for every column id", () => {
    expect(Object.keys(BOARD_COLUMN_LABELS).sort()).toEqual(["done", "failed", "new", "ready", "working"])
  })
})

describe("formatRelativeTime", () => {
  const now = Date.parse(T2)
  it.each([
    [T2, "just now"],
    ["2026-10-05T12:09:10.000Z", "just now"],
    ["2026-10-05T12:05:00.000Z", "5m ago"],
    ["2026-10-05T09:10:00.000Z", "3h ago"],
    ["2026-10-02T12:10:00.000Z", "3d ago"],
  ])("formats %s as %s", (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected)
  })

  it("never shows a negative age for a timestamp slightly in the future (clock skew)", () => {
    expect(formatRelativeTime("2026-10-05T12:10:30.000Z", now)).toBe("just now")
  })
})
