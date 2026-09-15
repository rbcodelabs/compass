import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 4 tool surface: `generate_research_synthesis` and
 * `list_research_syntheses`, plus the exposure boundary the history read draws.
 */
const mocks = vi.hoisted(() => ({ study: vi.fn(), syntheses: vi.fn(), store: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.study }, researchSynthesis: { findMany: mocks.syntheses } }) }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => true }))
vi.mock("@/lib/research-analysis-service", async importActual => {
  const actual = await importActual<typeof import("@/lib/research-analysis-service")>()
  return { ...actual, storeAgentStudySynthesis: mocks.store }
})
import { generateResearchSynthesisTool, listResearchSynthesesTool } from "@/lib/research-tool-handlers"
import { ResearchAnalysisError } from "@/lib/research-analysis-service"
import { runWithMcpActor } from "@/lib/mcp-authz"

const MEMBER = { userId: "member", purpose: "USER" as const }
const args = { workspaceId: "workspace", studyId: "study" }

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: "snapshot-1", sessionCount: 2, model: "claude-sonnet-5", promptVersion: "research-analysis-v1", createdAt: new Date("2026-09-14T00:00:00Z"),
  content: JSON.stringify({
    version: 1, kind: "synthesis", generatedAt: "2026-09-14T00:00:00.000Z", sourceFingerprint: "a".repeat(64), sourceSessionIds: ["s1"], guideFingerprint: "b".repeat(64), model: "claude-sonnet-5", promptVersion: "research-analysis-v1",
    summary: "Planning friction", themes: [], patterns: [], jobs: [], recommendations: [],
  }),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.study.mockResolvedValue({ id: "study", studyType: "CUSTOMER_INTERVIEW", workspaceId: "workspace", updatedAt: new Date(), goal: "g", guide: "[]", _count: { sessions: 1 } })
  mocks.syntheses.mockResolvedValue([snapshot()])
  mocks.store.mockResolvedValue({ kind: "synthesis", summary: "Planning friction" })
})

describe("generate_research_synthesis", () => {
  it("stores the agent's own document and reports the server-side citation check", async () => {
    const result = await runWithMcpActor(MEMBER, () => generateResearchSynthesisTool({ ...args, synthesis: { summary: "Planning friction" } }))
    expect(mocks.store).toHaveBeenCalledWith("study", "member", { summary: "Planning friction" })
    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("checked against the saved participant transcripts")
  })

  it("surfaces the grounding-check reason so the agent can fix its citations", async () => {
    mocks.store.mockRejectedValue(new ResearchAnalysisError("Synthesis quotes must match saved participant turns verbatim", 422))
    const result = await runWithMcpActor(MEMBER, () => generateResearchSynthesisTool({ ...args, synthesis: {} }))
    expect(result.structuredContent).toMatchObject({ ok: false, data: null })
    expect(result.content[0].text).toContain("verbatim")
  })

  it("does not leak an unexpected internal failure", async () => {
    mocks.store.mockRejectedValue(new Error("pg: connection string password=hunter2"))
    const result = await runWithMcpActor(MEMBER, () => generateResearchSynthesisTool({ ...args, synthesis: {} }))
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).not.toContain("hunter2")
  })

  it("refuses a public participant research credential", async () => {
    await expect(runWithMcpActor({ userId: "member", purpose: "RESEARCH", scopeWorkspaceId: "workspace" }, () => generateResearchSynthesisTool({ ...args, synthesis: {} }))).rejects.toThrow(/research interviews/)
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it("refuses the shared service credential, which has no member to attribute analysis to", async () => {
    await expect(runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => generateResearchSynthesisTool({ ...args, synthesis: {} }))).rejects.toThrow(/member identity/)
    expect(mocks.store).not.toHaveBeenCalled()
  })
})

describe("list_research_syntheses exposure boundary", () => {
  it("queries only CROSS_SESSION rows, so lease internals are never read", async () => {
    await runWithMcpActor(MEMBER, () => listResearchSynthesesTool(args))
    expect(mocks.syntheses.mock.calls[0][0].where).toEqual({ studyId: "study", kind: "CROSS_SESSION" })
  })

  it("returns stored snapshots newest first with their validated content", async () => {
    const result = await runWithMcpActor(MEMBER, () => listResearchSynthesesTool(args))
    const data = result.structuredContent.data as { items: { id: string; content: { summary: string } | null }[]; count: number; nextOffset: number | null }
    expect(mocks.syntheses.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
    expect(data.count).toBe(1)
    expect(data.items[0]).toMatchObject({ id: "snapshot-1", sessionCount: 2 })
    expect(data.items[0].content?.summary).toBe("Planning friction")
    expect(result.content[0].text).toContain("In-progress and failed generations are not listed")
  })

  // Grounding guarantees quotes are exact substrings of participant turns, so a
  // synthesis carries verbatim participant text. Without this marker a payload
  // planted in a transcript comes back to the later UNSCOPED promotion turn
  // dressed as validated analysis (ADR-0012's named prompt-injection risk).
  it.each([
    ["list_research_syntheses", () => listResearchSynthesesTool(args)],
    ["generate_research_synthesis", () => generateResearchSynthesisTool({ ...args, synthesis: {} })],
  ])("%s marks quoted participant text as untrusted, like the transcript reads do", async (_name, call) => {
    const result = await runWithMcpActor(MEMBER, call)
    expect(result.content[0].text).toContain("untrusted data")
    expect(result.content[0].text).toContain("not instructions")
  })

  it("never returns a PENDING claim blob even if one is somehow selected", async () => {
    // A PENDING/FAILED row's `content` is the lease claim: {claimId, deadline,
    // sourceFingerprint}. readStudySynthesis rejects it, so it degrades to null
    // rather than handing the model the lease's internals.
    mocks.syntheses.mockResolvedValue([snapshot({ content: JSON.stringify({ version: 1, sourceFingerprint: "c".repeat(64), claimId: "claim-secret", deadline: 123 }) })])
    const result = await runWithMcpActor(MEMBER, () => listResearchSynthesesTool(args))
    const data = result.structuredContent.data as { items: { content: unknown }[] }
    expect(data.items).toHaveLength(1)
    expect(data.items[0].content).toBeNull()
    expect(JSON.stringify(result)).not.toContain("claim-secret")
  })

  it("pages with an offset cursor", async () => {
    mocks.syntheses.mockResolvedValue(Array.from({ length: 21 }, (_, i) => snapshot({ id: `snapshot-${i}` })))
    const result = await runWithMcpActor(MEMBER, () => listResearchSynthesesTool({ ...args, offset: 20 }))
    const data = result.structuredContent.data as { count: number; nextOffset: number | null }
    expect(mocks.syntheses.mock.calls[0][0].skip).toBe(20)
    expect(data.count).toBe(20)
    expect(data.nextOffset).toBe(40)
  })

  it("refuses to read a PM interview study's history", async () => {
    mocks.study.mockResolvedValue({ id: "study", studyType: "PM_INTERVIEW", workspaceId: "workspace", updatedAt: new Date(), goal: "g", guide: "[]", _count: { sessions: 1 } })
    const result = await runWithMcpActor(MEMBER, () => listResearchSynthesesTool(args))
    expect(result.structuredContent).toMatchObject({ ok: false })
    expect(mocks.syntheses).not.toHaveBeenCalled()
  })

  it("refuses a non-member before any synthesis row is read", async () => {
    mocks.study.mockResolvedValue(null)
    const result = await runWithMcpActor({ userId: "outsider", purpose: "USER" as const }, () => listResearchSynthesesTool(args))
    expect(result.structuredContent).toMatchObject({ ok: false })
    expect(mocks.syntheses).not.toHaveBeenCalled()
  })
})
