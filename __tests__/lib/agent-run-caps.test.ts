import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))

import {
  AGENT_CAP_CEILINGS,
  DEFAULT_AGENT_MAX_CONCURRENT_RUNS,
  DEFAULT_AGENT_MAX_RUNS_PER_DAY,
  agentCapReachedBody,
  checkAgentRunCaps,
  getAgentRunCaps,
} from "@/lib/agent-limits"

type Run = { agentId: string | null; status: string; createdAt: Date }
type Caps = { maxConcurrentRuns: number | null; maxRunsPerDay: number | null }

const NOW = new Date("2026-10-21T12:00:00.000Z")
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)
const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

/** A tiny in-memory stand-in that evaluates the same where-clauses the real queries use. */
function fakePrisma(runs: Run[], caps: Record<string, Caps> = {}, options: { capsError?: unknown; runsError?: unknown } = {}) {
  const count = vi.fn(async ({ where }: { where: { agentId: string; status?: { in: string[] }; createdAt?: { gte: Date } } }) => {
    if (options.runsError) throw options.runsError
    return runs.filter((run) =>
      run.agentId === where.agentId &&
      (!where.status || where.status.in.includes(run.status)) &&
      (!where.createdAt || run.createdAt >= where.createdAt.gte)).length
  })
  const findFirst = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (options.capsError) throw options.capsError
    return caps[where.id] ?? null
  })
  return { prisma: { agent: { findFirst }, agentRun: { count } } as unknown as AppPrismaClient, count, findFirst }
}

const live = (agentId: string, n: number): Run[] => Array.from({ length: n }, () => ({ agentId, status: "RUNNING", createdAt: hoursAgo(0.1) }))
const done = (agentId: string, n: number, hours = 1): Run[] => Array.from({ length: n }, () => ({ agentId, status: "SUCCEEDED", createdAt: hoursAgo(hours) }))
const columnMissing = Object.assign(new Error("column agents.max_concurrent_runs does not exist"), { code: "P2022" })

describe("getAgentRunCaps", () => {
  it("uses the defaults (5 concurrent, 100 a day) when nothing is configured", async () => {
    const { prisma } = fakePrisma([], { [A]: { maxConcurrentRuns: null, maxRunsPerDay: null } })
    expect(await getAgentRunCaps(prisma, A)).toEqual({ maxConcurrentRuns: 5, maxRunsPerDay: 100, configuredMaxConcurrentRuns: null, configuredMaxRunsPerDay: null })
    expect([DEFAULT_AGENT_MAX_CONCURRENT_RUNS, DEFAULT_AGENT_MAX_RUNS_PER_DAY]).toEqual([5, 100])
  })

  it("uses the configured values, and treats a malformed stored value as unset", async () => {
    const { prisma } = fakePrisma([], { [A]: { maxConcurrentRuns: 2, maxRunsPerDay: 7 }, [B]: { maxConcurrentRuns: 0, maxRunsPerDay: -3 } })
    expect(await getAgentRunCaps(prisma, A)).toMatchObject({ maxConcurrentRuns: 2, maxRunsPerDay: 7, configuredMaxConcurrentRuns: 2, configuredMaxRunsPerDay: 7 })
    expect(await getAgentRunCaps(prisma, B)).toMatchObject({ maxConcurrentRuns: 5, maxRunsPerDay: 100 })
  })

  it("treats an unknown agent as the defaults", async () => {
    const { prisma } = fakePrisma([])
    expect(await getAgentRunCaps(prisma, A)).toMatchObject({ maxConcurrentRuns: 5, maxRunsPerDay: 100 })
  })

  it("falls back to the defaults when migration 102 is not applied, and rethrows any other fault", async () => {
    expect(await getAgentRunCaps(fakePrisma([], {}, { capsError: columnMissing }).prisma, A)).toMatchObject({ maxConcurrentRuns: 5, maxRunsPerDay: 100 })
    await expect(getAgentRunCaps(fakePrisma([], {}, { capsError: new Error("connection reset") }).prisma, A)).rejects.toThrow("connection reset")
  })

  it("publishes sane ceilings for administrators", () => {
    expect(AGENT_CAP_CEILINGS).toEqual({ maxConcurrentRuns: 50, maxRunsPerDay: 5000 })
  })
})

describe("checkAgentRunCaps", () => {
  it("allows a run under both default caps", async () => {
    expect(await checkAgentRunCaps(fakePrisma([...live(A, 4), ...done(A, 50)]).prisma, A, NOW)).toEqual({ allowed: true })
  })

  it("refuses at the concurrent cap (default 5), counting only QUEUED and RUNNING runs", async () => {
    const queued: Run = { agentId: A, status: "QUEUED", createdAt: hoursAgo(0.1) }
    const result = await checkAgentRunCaps(fakePrisma([...live(A, 4), queued, ...done(A, 3)]).prisma, A, NOW)
    expect(result).toMatchObject({ allowed: false, cap: "CONCURRENT", limit: 5 })
  })

  it("does not count finished, failed or canceled runs as concurrent", async () => {
    const finished = ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"].map((status): Run => ({ agentId: A, status, createdAt: hoursAgo(0.1) }))
    expect(await checkAgentRunCaps(fakePrisma([...finished, ...live(A, 4)]).prisma, A, NOW)).toEqual({ allowed: true })
  })

  it("refuses at the daily cap (default 100) whatever the outcome of those runs", async () => {
    const result = await checkAgentRunCaps(fakePrisma(done(A, 100, 2)).prisma, A, NOW)
    expect(result).toMatchObject({ allowed: false, cap: "DAILY", limit: 100 })
  })

  it("allows the 100th run (99 so far) and refuses the 101st", async () => {
    expect(await checkAgentRunCaps(fakePrisma(done(A, 99)).prisma, A, NOW)).toEqual({ allowed: true })
    expect((await checkAgentRunCaps(fakePrisma(done(A, 100)).prisma, A, NOW)).allowed).toBe(false)
  })

  it("uses a rolling 24 hour window: older runs age out", async () => {
    const runs = [...done(A, 60, 23.9), ...done(A, 60, 24.1)]
    expect(await checkAgentRunCaps(fakePrisma(runs).prisma, A, NOW)).toEqual({ allowed: true })
    expect((await checkAgentRunCaps(fakePrisma([...runs, ...done(A, 40, 23.9)]).prisma, A, NOW)).allowed).toBe(false)
  })

  it("honours a per-agent configured cap, lower or higher than the default", async () => {
    const low = fakePrisma(live(A, 2), { [A]: { maxConcurrentRuns: 2, maxRunsPerDay: null } })
    expect(await checkAgentRunCaps(low.prisma, A, NOW)).toMatchObject({ allowed: false, cap: "CONCURRENT", limit: 2 })
    const high = fakePrisma(live(A, 9), { [A]: { maxConcurrentRuns: 10, maxRunsPerDay: null } })
    expect(await checkAgentRunCaps(high.prisma, A, NOW)).toEqual({ allowed: true })
    const daily = fakePrisma(done(A, 3), { [A]: { maxConcurrentRuns: null, maxRunsPerDay: 3 } })
    expect(await checkAgentRunCaps(daily.prisma, A, NOW)).toMatchObject({ allowed: false, cap: "DAILY", limit: 3 })
  })

  it("isolates agents: one agent's runs never use another's allowance", async () => {
    const runs = [...live(A, 5), ...done(A, 100)]
    const { prisma } = fakePrisma(runs, { [B]: { maxConcurrentRuns: 1, maxRunsPerDay: 1 } })
    expect((await checkAgentRunCaps(prisma, A, NOW)).allowed).toBe(false)
    expect(await checkAgentRunCaps(prisma, B, NOW)).toEqual({ allowed: true })
  })

  it("reports the concurrent cap first when both are reached, and the message names the limit", async () => {
    const result = await checkAgentRunCaps(fakePrisma([...live(A, 5), ...done(A, 100)]).prisma, A, NOW)
    expect(result).toMatchObject({ allowed: false, cap: "CONCURRENT" })
    if (!result.allowed) expect(result.reason).toMatch(/limit 5/)
  })

  it("scopes both counts to the agent id (never a global count)", async () => {
    const { prisma, count } = fakePrisma([])
    await checkAgentRunCaps(prisma, A, NOW)
    for (const [arg] of count.mock.calls) expect(arg.where.agentId).toBe(A)
  })

  it("allows when agent_runs has no agent_id column (migration 100 not applied), and rethrows other faults", async () => {
    expect(await checkAgentRunCaps(fakePrisma([], {}, { runsError: columnMissing }).prisma, A, NOW)).toEqual({ allowed: true })
    await expect(checkAgentRunCaps(fakePrisma([], {}, { runsError: new Error("boom") }).prisma, A, NOW)).rejects.toThrow("boom")
  })

  it("is not fooled by an unapplied migration 102 for the caps lookup: defaults still apply", async () => {
    const { prisma } = fakePrisma(live(A, 5), {}, { capsError: columnMissing })
    expect(await checkAgentRunCaps(prisma, A, NOW)).toMatchObject({ allowed: false, cap: "CONCURRENT", limit: 5 })
  })
})

describe("agentCapReachedBody", () => {
  it("is the typed 429 payload the API and the UI read", () => {
    expect(agentCapReachedBody({ allowed: false, cap: "DAILY", limit: 100, reason: "r" })).toEqual({ error: "r", code: "AGENT_CAP_REACHED", cap: "DAILY", limit: 100 })
  })
})
