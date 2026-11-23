import { describe, it, expect, vi } from "vitest"
import { costCaptureStartedAt, fetchSpendRows } from "@/lib/agent-spend"

const day = (s: string) => new Date(s + "T12:00:00.000Z")

function fakePrisma(runs: unknown[], messages: unknown[]) {
  return {
    agentRun: { findMany: vi.fn().mockResolvedValue(runs) },
    agentMessage: { findMany: vi.fn().mockResolvedValue(messages) },
  } as never
}

const window = { workspaceId: "ws-1", since: day("2026-11-01"), until: day("2026-11-08") }

describe("fetchSpendRows", () => {
  it("counts a detached run once: run cost, and only run-less messages", async () => {
    const prisma = fakePrisma(
      [{ createdAt: day("2026-11-02"), status: "SUCCEEDED", userId: "u1", agentId: null, kind: "CHAT", model: "m", costUsd: 1.5 }],
      [{ createdAt: day("2026-11-03"), authorUserId: null, model: "m", costUsd: 0.25, conversation: { userId: "u2" } }],
    )
    const r = await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })
    expect(r.rows.map((x) => [x.source, x.costUsd])).toEqual([["run", 1.5], ["message", 0.25]])
    // The message query itself excludes run-owned messages, which is what prevents the double count.
    const messageWhere = (prisma as never as { agentMessage: { findMany: { mock: { calls: [{ where: Record<string, unknown> }][] } } } }).agentMessage.findMany.mock.calls[0][0].where
    expect(messageWhere.runId).toBeNull()
    expect(messageWhere.role).toBe("assistant")
    expect(messageWhere.conversation).toEqual({ workspaceId: "ws-1" })
  })

  it("attributes a run-less message to its author, falling back to the conversation owner", async () => {
    const prisma = fakePrisma([], [
      { createdAt: day("2026-11-02"), authorUserId: "asker", model: null, costUsd: 1, conversation: { userId: "owner" } },
      { createdAt: day("2026-11-02"), authorUserId: null, model: null, costUsd: 1, conversation: { userId: "owner" } },
    ])
    const r = await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })
    expect(r.rows.map((x) => x.userId)).toEqual(["asker", "owner"])
  })

  it("counts terminal runs with no cost as unknown, never zero, and ignores in-flight runs", async () => {
    const prisma = fakePrisma([
      { createdAt: day("2026-11-02"), status: "INTERRUPTED", userId: "u1", agentId: null, kind: "CHAT", model: null, costUsd: null },
      { createdAt: day("2026-11-02"), status: "RUNNING", userId: "u1", agentId: null, kind: "CHAT", model: null, costUsd: null },
      { createdAt: day("2026-11-02"), status: "FAILED", userId: "u1", agentId: null, kind: "CHAT", model: null, costUsd: 0.4 },
    ], [])
    const r = await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })
    expect(r.nullCostRuns).toBe(1)
    expect(r.rows).toHaveLength(2)
    expect(r.rows.find((x) => x.costUsd === null)).toBeDefined() // kept as null, not coerced to 0
    expect(r.rows.find((x) => x.costUsd === 0.4)).toBeDefined() // failed-run spend is included
  })

  it("counts run-less messages with no cost", async () => {
    const prisma = fakePrisma([], [{ createdAt: day("2026-11-02"), authorUserId: null, model: null, costUsd: null, conversation: { userId: "u" } }])
    expect((await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })).nullCostMessages).toBe(1)
  })

  it("buckets by UTC day", async () => {
    const at = new Date("2026-11-02T23:30:00.000Z")
    const prisma = fakePrisma([{ createdAt: at, status: "SUCCEEDED", userId: "u", agentId: null, kind: "CHAT", model: null, costUsd: 1 }], [])
    expect((await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })).rows[0].date).toBe("2026-11-02")
  })

  it("flags possible legacy overlap when the window starts before the capture fix, or the fix date is unknown", async () => {
    const prisma = fakePrisma([], [])
    expect((await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-11-05") })).legacyOverlapPossible).toBe(true)
    expect((await fetchSpendRows(prisma, { ...window, captureStartedAt: null })).legacyOverlapPossible).toBe(true)
    expect((await fetchSpendRows(prisma, { ...window, captureStartedAt: day("2026-10-01") })).legacyOverlapPossible).toBe(false)
  })
})

describe("costCaptureStartedAt", () => {
  it("parses the env timestamp and ignores garbage", () => {
    expect(costCaptureStartedAt({ AGENT_COST_CAPTURE_STARTED_AT: "2026-11-03T00:00:00Z" } as never)?.toISOString()).toBe("2026-11-03T00:00:00.000Z")
    expect(costCaptureStartedAt({ AGENT_COST_CAPTURE_STARTED_AT: "nope" } as never)).toBeNull()
    expect(costCaptureStartedAt({} as never)).toBeNull()
  })
})
