import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ study: vi.fn(), session: vi.fn(), update: vi.fn(), agent: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.study }, researchSession: { findFirst: mocks.session, updateMany: mocks.update } }) }))
vi.mock("@/lib/research-analysis-agent", () => ({ runResearchAnalysisAgent: mocks.agent }))
import { generateSessionAnalysis } from "@/lib/research-analysis-service"
import { parseAnalysisResult } from "@/lib/research-analysis"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.study.mockResolvedValue({ id: "study", goal: "Goal", guide: '[{"id":"q","text":"Why?"}]' })
  mocks.session.mockResolvedValue({ id: "session", status: "COMPLETED", modality: "CHAT", summary: null, turns: [{ id: "turn", role: "PARTICIPANT", content: "It was slow", sequence: 1 }] })
  mocks.update.mockResolvedValue({ count: 1 })
  mocks.agent.mockResolvedValue('{"summary":"Slow process","evidenceTurnIds":["turn"]}')
})
afterEach(() => vi.unstubAllEnvs())
describe("saved research analysis", () => {
  it("authorizes membership before reading transcripts or running a model", async () => {
    mocks.study.mockResolvedValue(null)
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "outsider" })).rejects.toThrow(/not found/)
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("rejects incomplete interviews without allocating a model", async () => {
    mocks.session.mockResolvedValue({ status: "IN_PROGRESS" })
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).rejects.toThrow(/completed/)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("claims the exact prior summary and stores only validated persisted-source output", async () => {
    const result = await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })
    expect(result).toMatchObject({ kind: "summary", summary: "Slow process" })
    expect(mocks.update.mock.calls[0][0].where).toMatchObject({ id: "session", studyId: "study", status: "COMPLETED", summary: null })
    expect(mocks.update.mock.calls[1][0].data.summary).toContain('"sourceFingerprint"')
  })
  it("does not allocate after a concurrent claim loses", async () => {
    mocks.update.mockResolvedValue({ count: 0 })
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).rejects.toThrow(/progress/)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("retains a failure receipt without changing completion status", async () => {
    mocks.agent.mockRejectedValue(new Error("secret model error"))
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).rejects.toThrow(/unavailable/)
    const writes = mocks.update.mock.calls.map(call => call[0].data)
    expect(writes.every(write => !('status' in write))).toBe(true)
    expect(writes.at(-1).summary).toContain('"failed":"summary"')
    expect(writes.at(-1).summary).not.toContain("secret")
  })
  it("does not silently truncate oversized transcripts", async () => {
    mocks.session.mockResolvedValue({ id: "session", status: "COMPLETED", modality: "CHAT", summary: null, turns: Array.from({ length: 2001 }, (_, i) => ({ id: String(i), role: "PARTICIPANT", content: "Answer", sequence: i })) })
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).rejects.toThrow(/too large/)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it("uses a matching cached result unless regeneration was requested", async () => {
    const session = await mocks.session()
    const result = parseAnalysisResult("summary", '{"summary":"Cached","evidenceTurnIds":["turn"]}', { goal: "Goal", guide: [{ id: "q", text: "Why?" }], sessions: [{ id: "session", modality: "CHAT", turns: session.turns }] })
    mocks.session.mockResolvedValue({ ...session, summary: JSON.stringify({ version: 1, summary: result }) })
    expect(await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).toEqual(result)
    expect(mocks.agent).not.toHaveBeenCalled()
    await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member", regenerate: true })
    expect(mocks.agent).toHaveBeenCalledTimes(1)
  })
  it("fences a late result after its claim was replaced", async () => {
    mocks.update.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 })
    await expect(generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).rejects.toThrow(/changed/)
    expect(mocks.update.mock.calls[2][0].where.summary).toBe(mocks.update.mock.calls[0][0].data.summary)
  })
  it("allows expired claim recovery but never automatic repeat allocations", async () => {
    const session = await mocks.session()
    mocks.session.mockResolvedValue({ ...session, summary: JSON.stringify({ version: 1, pending: { id: "old", startedAt: "2000-01-01T00:00:00Z" } }) })
    expect(await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", automatic: true })).toBeNull()
    expect(mocks.agent).not.toHaveBeenCalled()
    await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })
    expect(mocks.agent).toHaveBeenCalledTimes(1)
  })
  it("uses deterministic analysis only in explicitly isolated non-production functional runs", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    vi.stubEnv("E2E_ISOLATED_DATABASE", "1")
    expect(await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })).toMatchObject({ summary: "Test analysis: participant described their experience." })
    expect(mocks.agent).not.toHaveBeenCalled()
    vi.stubEnv("NODE_ENV", "production")
    await generateSessionAnalysis({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })
    expect(mocks.agent).toHaveBeenCalledTimes(1)
  })
})
