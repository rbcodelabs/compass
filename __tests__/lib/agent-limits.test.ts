import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAgentMessage = { aggregate: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ agentMessage: mockAgentMessage }) }))

import { checkAgentUsageLimit } from "@/lib/agent-limits"

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.AGENT_MAX_TURNS_PER_DAY
  delete process.env.AGENT_MAX_COST_USD_PER_DAY
})

describe("checkAgentUsageLimit", () => {
  it("allows a user under both caps", async () => {
    mockAgentMessage.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { costUsd: 0.5 } })
    expect(await checkAgentUsageLimit("user-1")).toEqual({ allowed: true })
    // Scoped by user + role + a 24h window.
    const arg = mockAgentMessage.aggregate.mock.calls[0][0]
    expect(arg.where.role).toBe("assistant")
    // Charged to whoever asked; rows from before sharing (no author) fall to the owner.
    expect(arg.where.OR).toEqual([{ authorUserId: "user-1" }, { authorUserId: null, conversation: { userId: "user-1" } }])
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date)
  })

  it("falls back to the owner-only query before migration 080 is applied", async () => {
    mockAgentMessage.aggregate
      .mockRejectedValueOnce(Object.assign(new Error("column missing"), { code: "P2022" }))
      .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { costUsd: 0.1 } })
    expect(await checkAgentUsageLimit("user-1")).toEqual({ allowed: true })
    expect(mockAgentMessage.aggregate.mock.calls[1][0].where.conversation).toEqual({ userId: "user-1" })
  })

  it("does not swallow other database errors", async () => {
    mockAgentMessage.aggregate.mockRejectedValue(new Error("connection reset"))
    await expect(checkAgentUsageLimit("user-1")).rejects.toThrow("connection reset")
  })

  it("blocks when the turn count cap is reached", async () => {
    process.env.AGENT_MAX_TURNS_PER_DAY = "5"
    mockAgentMessage.aggregate.mockResolvedValue({ _count: { _all: 5 }, _sum: { costUsd: 0.1 } })
    const r = await checkAgentUsageLimit("user-1")
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/turn limit/)
  })

  it("blocks when the cost cap is reached", async () => {
    process.env.AGENT_MAX_COST_USD_PER_DAY = "2"
    mockAgentMessage.aggregate.mockResolvedValue({ _count: { _all: 4 }, _sum: { costUsd: 2.5 } })
    const r = await checkAgentUsageLimit("user-1")
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/spend limit/)
  })

  it("treats a null cost sum as zero", async () => {
    mockAgentMessage.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { costUsd: null } })
    expect(await checkAgentUsageLimit("user-1")).toEqual({ allowed: true })
  })
})
