import { describe, expect, it } from "vitest"
import { groupConversationsByStatus } from "@/lib/agent-board"

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  messageCount: 2,
  runStatus: null,
  lastActivityAt: "2026-10-24T10:00:00.000Z",
  reviewedAt: "2026-10-24T11:00:00.000Z",
  ...over,
})

describe("groupConversationsByStatus", () => {
  it("returns null without status data so the rail keeps a flat list", () => {
    expect(groupConversationsByStatus([{ id: "a", title: "a" }])).toBeNull()
    expect(groupConversationsByStatus([])).toBeNull()
  })

  it("groups working first and sorts each group by most recent activity", () => {
    const groups = groupConversationsByStatus([
      row("old-done"),
      row("failed", { runStatus: "FAILED" }),
      row("run-old", { runStatus: "RUNNING", lastActivityAt: "2026-10-24T09:00:00.000Z" }),
      row("run-new", { runStatus: "RUNNING", lastActivityAt: "2026-10-24T12:00:00.000Z" }),
      row("unread", { reviewedAt: null }),
    ])!
    expect(groups.map((g) => g.id)).toEqual(["working", "new", "done", "failed"])
    expect(groups[0].items.map((c) => c.id)).toEqual(["run-new", "run-old"])
  })
})
