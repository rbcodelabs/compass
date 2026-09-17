import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 6 deleted `generateStudySynthesis`, the standalone producer this
 * file used to drive. The lease it ran under — `withSynthesisLease` — is *not*
 * retired: it is what `generate_research_synthesis` stores through, so these
 * tests now exercise it directly with a stand-in producer.
 *
 * Deliberately narrow. `research-synthesis-agent-store.test.ts` already covers
 * authorization, the in-progress conflict, the lost study claim, source limits
 * and the FAILED-row-on-invalid-document path through the real caller. Kept here
 * is only what that file cannot reach, because its producer is `async () => raw`
 * and therefore can neither run long nor throw:
 *   - a producer that overruns the operation deadline,
 *   - a pending row replaced underneath both the success and failure writes,
 *   - a producer that throws text of its own, under the default fixed wording.
 */
const mocks = vi.hoisted(() => ({ access: vi.fn(), sessions: vi.fn(), pending: vi.fn(), claim: vi.fn(), create: vi.fn(), update: vi.fn(), agent: vi.fn() }))
vi.mock("@/lib/research-analysis-agent", () => ({ runResearchAnalysisAgent: mocks.agent }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.access }, researchSession: { findMany: mocks.sessions }, researchSynthesis: { updateMany: mocks.update }, $transaction: async (fn: (tx: unknown) => unknown) => fn({ researchStudy: { updateMany: mocks.claim }, researchSynthesis: { findFirst: mocks.pending, create: mocks.create } }) }) }))
import { loadSynthesisSource, withSynthesisLease } from "@/lib/research-analysis-service"

const document = JSON.stringify({ summary: "Planning friction", themes: [{ title: "Slow planning", description: "Time cost", surprising: true, quotes: [{ sessionId: "s1", turnId: "t1", text: "takes hours" }] }], patterns: [], jobs: [], recommendations: [] })
const lease = async (produce: (source: unknown, deadline: number) => Promise<string>) => withSynthesisLease(await loadSynthesisSource("study", "member"), produce)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({ id: "study", goal: "Planning", guide: "[]", updatedAt: new Date("2020-01-01") })
  mocks.sessions.mockResolvedValue([{ id: "s1", modality: "CHAT", turns: [{ id: "t1", role: "PARTICIPANT", content: "Planning takes hours", sequence: 0 }] }])
  mocks.pending.mockResolvedValue(null); mocks.claim.mockResolvedValue({ count: 1 }); mocks.create.mockResolvedValue({ id: "snapshot" }); mocks.update.mockResolvedValue({ count: 1 })
})

describe("research synthesis lease", () => {
  afterEach(() => vi.useRealTimers())

  it("stores a validated document and never reaches the retired standalone pipeline", async () => {
    expect(await lease(async () => document)).toMatchObject({ kind: "synthesis", model: "claude-sonnet-5", promptVersion: "research-analysis-v1" })
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: "snapshot" }, data: { kind: "CROSS_SESSION" } })
    expect(mocks.sessions.mock.calls[0][0].where).toEqual({ studyId: "study", status: "COMPLETED" })
  })

  it("rejects a late result instead of marking an expired snapshot successful", async () => {
    vi.useFakeTimers()
    await expect(lease(async () => { vi.setSystemTime(Date.now() + 180_001); return document })).rejects.toThrow(/unavailable/)
    expect(mocks.update.mock.calls.some(call => call[0].data.kind === "CROSS_SESSION")).toBe(false)
  })

  it("fences success and failure writes against a replaced pending snapshot", async () => {
    mocks.update.mockResolvedValue({ count: 0 })
    await expect(lease(async () => document)).rejects.toThrow(/changed/)
    for (const [write] of mocks.update.mock.calls) {
      expect(write.where).toMatchObject({ id: "snapshot", kind: "PENDING" })
      expect(write.where.content).toEqual(expect.any(String))
    }
  })

  it("retains a failed receipt and keeps producer failure text behind fixed wording", async () => {
    await expect(lease(async () => { throw new Error("secret") })).rejects.toThrow(/previous results are unchanged/)
    await expect(lease(async () => { throw new Error("secret") })).rejects.not.toThrow(/secret/)
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: "snapshot" }, data: { kind: "FAILED" } })
  })
})
