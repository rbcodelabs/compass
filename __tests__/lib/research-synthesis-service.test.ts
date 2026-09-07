import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ access: vi.fn(), sessions: vi.fn(), pending: vi.fn(), claim: vi.fn(), create: vi.fn(), update: vi.fn(), agent: vi.fn() }))
vi.mock("@/lib/research-analysis-agent", () => ({ runResearchAnalysisAgent: mocks.agent }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.access }, researchSession: { findMany: mocks.sessions }, researchSynthesis: { update: mocks.update }, $transaction: async (fn: (tx: unknown) => unknown) => fn({ researchStudy: { updateMany: mocks.claim }, researchSynthesis: { findFirst: mocks.pending, create: mocks.create } }) }) }))
import { generateStudySynthesis } from "@/lib/research-analysis-service"
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({ id: "study", goal: "Planning", guide: "[]", updatedAt: new Date("2020-01-01") })
  mocks.sessions.mockResolvedValue([{ id: "s1", modality: "CHAT", turns: [{ id: "t1", role: "PARTICIPANT", content: "Planning takes hours", sequence: 0 }] }])
  mocks.pending.mockResolvedValue(null); mocks.claim.mockResolvedValue({ count: 1 }); mocks.create.mockResolvedValue({ id: "snapshot" }); mocks.update.mockResolvedValue({})
  mocks.agent.mockResolvedValue(JSON.stringify({ summary: "Planning friction", themes: [{ title: "Slow planning", description: "Time cost", surprising: true, quotes: [{ sessionId: "s1", turnId: "t1", text: "takes hours" }] }], patterns: [], jobs: [], recommendations: [] }))
})
describe("research synthesis snapshots", () => {
  it("authorizes before reading any source data", async () => {
    mocks.access.mockResolvedValue(null)
    await expect(generateStudySynthesis("study", "outsider")).rejects.toThrow(/not found/)
    expect(mocks.sessions).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("generates a new snapshot without overwriting previous successful synthesis", async () => {
    expect(await generateStudySynthesis("study", "member")).toMatchObject({ kind: "synthesis", model: "claude-sonnet-5", promptVersion: "research-analysis-v1" })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: "snapshot" }, data: { kind: "CROSS_SESSION" } })
    expect(mocks.sessions.mock.calls[0][0].where).toEqual({ studyId: "study", status: "COMPLETED" })
  })
  it("serializes simultaneous generations before allocating the model", async () => {
    mocks.claim.mockResolvedValue({ count: 0 })
    await expect(generateStudySynthesis("study", "member")).rejects.toThrow(/changed/)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it("does not generate while an unexpired snapshot is pending", async () => {
    mocks.pending.mockResolvedValue({ id: "running" })
    await expect(generateStudySynthesis("study", "member")).rejects.toThrow(/progress/)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("retains a failed receipt and leaves historic successful records untouched", async () => {
    mocks.agent.mockRejectedValue(new Error("secret"))
    await expect(generateStudySynthesis("study", "member")).rejects.toThrow(/previous results are unchanged/)
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: "snapshot" }, data: { kind: "FAILED" } })
  })
  it("fails explicitly above the source limit instead of analyzing an undisclosed subset", async () => {
    mocks.sessions.mockResolvedValue(Array.from({ length: 501 }, (_, i) => ({ id: String(i), modality: "CHAT", turns: [] })))
    await expect(generateStudySynthesis("study", "member")).rejects.toThrow(/nothing was truncated/)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
})
