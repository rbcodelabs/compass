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
    expect(arg.where.conversation).toEqual({ userId: "user-1" })
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date)
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
