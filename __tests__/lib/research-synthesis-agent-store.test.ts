import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 4: the core agent produces the synthesis and hands it to a tool
 * that only validates and stores. There is deliberately no nested model call
 * here — `runResearchAnalysisAgent` must never be reached on this path.
 *
 * The integrity argument is that the agent's payload goes through the exact
 * same `parseAnalysisResult` the retired pipeline used, against a `source`
 * rebuilt server-side from saved rows. A hallucinated quote or an unknown turn
 * id must fail that check and leave the lease row FAILED, never CROSS_SESSION.
 */
const mocks = vi.hoisted(() => ({ access: vi.fn(), sessions: vi.fn(), pending: vi.fn(), claim: vi.fn(), create: vi.fn(), update: vi.fn(), agent: vi.fn() }))
vi.mock("@/lib/research-analysis-agent", () => ({ runResearchAnalysisAgent: mocks.agent }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.access }, researchSession: { findMany: mocks.sessions }, researchSynthesis: { updateMany: mocks.update }, $transaction: async (fn: (tx: unknown) => unknown) => fn({ researchStudy: { updateMany: mocks.claim }, researchSynthesis: { findFirst: mocks.pending, create: mocks.create } }) }) }))
import { storeAgentStudySynthesis } from "@/lib/research-analysis-service"

const TURN = { id: "t1", role: "PARTICIPANT", content: "Planning takes hours every single week", sequence: 0 }
const TURN_TWO = { id: "t2", role: "PARTICIPANT", content: "I rebuild the same sheet each Monday", sequence: 0 }

const valid = () => ({
  summary: "Planning friction dominates the week.",
  themes: [{ title: "Slow planning", description: "Time cost recurs.", surprising: true, quotes: [{ sessionId: "s1", turnId: "t1", text: "takes hours" }] }],
  patterns: [{ text: "Manual rebuild every week", evidenceTurnIds: ["t1", "t2"] }],
  jobs: [{ job: "When Monday arrives, I want a ready plan, so I can start work", context: "Weekly planning", evidenceTurnIds: ["t1"] }],
  recommendations: [{ text: "Persist last week's plan", evidenceTurnIds: ["t2"] }],
})

const kinds = () => mocks.update.mock.calls.map(([call]) => call.data.kind)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({ id: "study", goal: "Planning", guide: "[]", updatedAt: new Date("2020-01-01") })
  mocks.sessions.mockResolvedValue([
    { id: "s1", modality: "CHAT", turns: [TURN] },
    { id: "s2", modality: "CHAT", turns: [TURN_TWO] },
  ])
  mocks.pending.mockResolvedValue(null); mocks.claim.mockResolvedValue({ count: 1 }); mocks.create.mockResolvedValue({ id: "snapshot" }); mocks.update.mockResolvedValue({ count: 1 })
})

describe("agent-supplied synthesis", () => {
  it("stores a grounded document under the existing lease without running a second model", async () => {
    const result = await storeAgentStudySynthesis("study", "member", valid())
    expect(result).toMatchObject({ kind: "synthesis", summary: "Planning friction dominates the week.", model: "claude-sonnet-5", promptVersion: "research-analysis-v1" })
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][0].data.kind).toBe("PENDING")
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: "snapshot", kind: "PENDING" }, data: { kind: "CROSS_SESSION" } })
    // Source is rebuilt server-side from COMPLETED sessions, not supplied.
    expect(mocks.sessions.mock.calls[0][0].where).toEqual({ studyId: "study", status: "COMPLETED" })
  })

  it("rejects a fabricated quote and persists nothing but a FAILED row", async () => {
    const forged = valid()
    forged.themes[0].quotes[0].text = "planning is a nightmare"
    await expect(storeAgentStudySynthesis("study", "member", forged)).rejects.toThrow(/verbatim/)
    expect(kinds()).toEqual(["FAILED"])
    expect(kinds()).not.toContain("CROSS_SESSION")
  })

  it("rejects an unknown turn id and persists nothing but a FAILED row", async () => {
    const forged = valid()
    forged.recommendations[0].evidenceTurnIds = ["turn-that-does-not-exist"]
    await expect(storeAgentStudySynthesis("study", "member", forged)).rejects.toThrow(/invalid evidence references/)
    expect(kinds()).toEqual(["FAILED"])
  })

  it("rejects a quote attributed to the wrong session", async () => {
    const forged = valid()
    forged.themes[0].quotes[0].sessionId = "s2"
    await expect(storeAgentStudySynthesis("study", "member", forged)).rejects.toThrow(/verbatim/)
    expect(kinds()).toEqual(["FAILED"])
  })

  it("rejects a cross-session pattern supported by only one session", async () => {
    const forged = valid()
    forged.patterns[0].evidenceTurnIds = ["t1"]
    await expect(storeAgentStudySynthesis("study", "member", forged)).rejects.toThrow(/two sessions/)
    expect(kinds()).toEqual(["FAILED"])
  })

  it("rejects an unknown field rather than storing an unvalidated document", async () => {
    await expect(storeAgentStudySynthesis("study", "member", { ...valid(), storedProcedure: "drop" })).rejects.toThrow()
    expect(kinds()).toEqual(["FAILED"])
  })

  it("authorizes membership before reading any transcript", async () => {
    mocks.access.mockResolvedValue(null)
    await expect(storeAgentStudySynthesis("study", "outsider", valid())).rejects.toThrow(/not found/)
    expect(mocks.sessions).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("refuses a PM interview study", async () => {
    mocks.access.mockResolvedValue({ id: "study", studyType: "PM_INTERVIEW", goal: "", guide: "[]", updatedAt: new Date() })
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/not found/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns the in-progress conflict instead of a second concurrent generation", async () => {
    mocks.pending.mockResolvedValue({ id: "running" })
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/Synthesis already in progress/)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("serializes a lost study claim without creating a snapshot", async () => {
    mocks.claim.mockResolvedValue({ count: 0 })
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/changed/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("fails explicitly above the source limit instead of storing an undisclosed subset", async () => {
    mocks.sessions.mockResolvedValue(Array.from({ length: 501 }, (_, i) => ({ id: String(i), modality: "CHAT", turns: [] })))
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/nothing was truncated/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("refuses when no saved participant evidence exists at all", async () => {
    mocks.sessions.mockResolvedValue([{ id: "s1", modality: "CHAT", turns: [{ id: "t1", role: "INTERVIEWER", content: "Hello?", sequence: 0 }] }])
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/No saved participant responses/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("requires an authenticated member identity", async () => {
    await expect(storeAgentStudySynthesis("study", "", valid())).rejects.toThrow(/Authentication required/)
    expect(mocks.access).not.toHaveBeenCalled()
  })

  it("rejects an oversized document before claiming the lease", async () => {
    // synthesisSchema admits far more than parseAnalysisResult's 100,000-char
    // ceiling, so this must fail without burning a PENDING row or bumping the
    // study's optimistic updatedAt.
    const huge = valid()
    huge.summary = "x".repeat(100_001)
    await expect(storeAgentStudySynthesis("study", "member", huge)).rejects.toThrow(/too large/)
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  // The validation reason is surfaced deliberately (the agent wrote the document
  // and can fix its citations). Nothing else may be: a failure from the storage
  // write is infrastructure detail and must stay behind the fixed wording.
  it("does not surface database failure text from the success write", async () => {
    mocks.update.mockImplementation(async ({ data }: { data: { kind: string } }) => {
      if (data.kind === "CROSS_SESSION") throw new Error("pg: relation research_syntheses, password=hunter2")
      return { count: 1 }
    })
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.toThrow(/previous results are unchanged/)
    await expect(storeAgentStudySynthesis("study", "member", valid())).rejects.not.toThrow(/hunter2/)
    expect(kinds()).toContain("FAILED")
  })
})
