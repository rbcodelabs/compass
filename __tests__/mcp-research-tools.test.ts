import { beforeEach, describe, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ service: vi.fn() }))
vi.mock("@/lib/research-study-service", () => ({
  createResearchStudy: m.service, updateResearchStudy: m.service, generateResearchGuide: m.service,
  listResearchStudies: m.service, getResearchStudy: m.service, activateResearchStudy: m.service,
  closeResearchStudy: m.service, archiveResearchStudy: m.service, issueResearchLink: m.service,
  regenerateResearchLink: m.service, revokeResearchLinks: m.service,
  listResearchSessions: m.service, getResearchSession: m.service, listResearchSyntheses: m.service,
  ResearchStudyError: class ResearchStudyError extends Error {},
}))
// ADR-0012 step 4 added generate_research_synthesis, whose handler reaches the
// analysis service rather than the study service. Mocked so the exhaustive
// public-research-credential denial below keeps covering every adapter.
vi.mock("@/lib/research-analysis-service", () => ({ storeAgentStudySynthesis: m.service, ResearchAnalysisError: class ResearchAnalysisError extends Error {} }))
import * as handlers from "@/lib/research-tool-handlers"
import { runWithMcpActor } from "@/lib/mcp-authz"
const input = { workspaceId: "workspace", studyId: "study", sessionId: "session", name: "Study", goal: "Goal", guide: ["Question"], studyType: "CUSTOMER_INTERVIEW" as const, appUrl: "", targetMinutes: 15, synthesis: {} }
beforeEach(() => { vi.clearAllMocks(); m.service.mockResolvedValue({ id: "study" }) })
describe("research MCP adapters", () => {
  it("denies every tool to a public research credential before calling services", async () => {
    for (const handler of Object.values(handlers)) {
      await expect(runWithMcpActor({ userId: "member", purpose: "RESEARCH", scopeWorkspaceId: "workspace" }, () => handler(input))).rejects.toThrow(/research interviews/)
    }
    expect(m.service).not.toHaveBeenCalled()
  })
  it("preserves the acting member and exact mutation ID output", async () => {
    const result = await runWithMcpActor({ userId: "member", purpose: "USER" }, () => handlers.createResearchStudyTool(input))
    expect(m.service.mock.calls[0].slice(0, 2)).toEqual([{ workspaceId: "workspace" }, { userId: "member", service: false, source: "MCP" }])
    expect(result.content[0].text.split("\n")).toContain("ID: study")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: "study" } })
  })
  it("preserves the deliberate shared service-key actor", async () => {
    await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => handlers.getResearchStudyTool(input))
    expect(m.service.mock.calls[0][1]).toEqual({ userId: null, service: true, source: "MCP" })
  })
  it("does not expose internal database errors", async () => {
    m.service.mockRejectedValue(new Error("database password=private"))
    const result = await runWithMcpActor({ userId: "member" }, () => handlers.getResearchStudyTool(input))
    expect(JSON.stringify(result)).not.toContain("private")
    expect(result.structuredContent.ok).toBe(false)
  })
  it("degrades to a missing participant link instead of failing the mutation when the production URL is misconfigured", async () => {
    m.service.mockResolvedValue({ id: "study", token: "secret-token" })
    delete process.env.NEXT_PUBLIC_APP_URL
    process.env.VERCEL_ENV = "production"
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass-rbcodelabs-team.vercel.app"
    try {
      const result = await runWithMcpActor({ userId: "member" }, () => handlers.issueResearchLinkTool(input))
      expect(result.structuredContent).toMatchObject({ ok: true, data: { participantUrl: null } })
      expect(result.content[0].text).not.toContain("vercel.app")
    } finally {
      delete process.env.VERCEL_ENV
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    }
  })

  it("limits guide generation to a 45-second invocation", async () => {
    const start = Date.now()
    await runWithMcpActor({ userId: "member" }, () => handlers.generateResearchGuideTool(input))
    expect(m.service.mock.calls[0][3]).toBeGreaterThanOrEqual(start + 45_000)
    expect(m.service.mock.calls[0][3]).toBeLessThanOrEqual(Date.now() + 45_000)
  })
})
