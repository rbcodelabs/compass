import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ auth: vi.fn(), session: vi.fn(), synthesis: vi.fn(), enabled: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: mocks.enabled }))
vi.mock("@/lib/research-analysis-service", () => ({ generateSessionAnalysis: mocks.session, generateStudySynthesis: mocks.synthesis, ResearchAnalysisError: class extends Error { status = 422 } }))
import { POST } from "@/app/api/research/analysis/route"
const request = (body: unknown, origin = "http://localhost") => new Request("http://localhost/api/research/analysis", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "member" } }); mocks.enabled.mockReturnValue(true); mocks.session.mockResolvedValue({ summary: "Saved" }); mocks.synthesis.mockResolvedValue({ summary: "Synthesis" }) })
describe("researcher analysis route", () => {
  it("requires an authenticated member identity", async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await POST(request({ studyId: "study", kind: "synthesis" }))).status).toBe(401)
    expect(mocks.synthesis).not.toHaveBeenCalled()
  })
  it("rejects cross-origin writes", async () => {
    expect((await POST(request({ studyId: "study", kind: "synthesis" }, "https://attacker.test"))).status).toBe(403)
  })
  it("accepts only persisted identifiers, never client transcripts", async () => {
    expect((await POST(request({ studyId: "study", kind: "summary", sessionId: "session", messages: [] }))).status).toBe(400)
    expect(mocks.session).not.toHaveBeenCalled()
  })
  it("passes membership to the shared service", async () => {
    expect((await POST(request({ studyId: "study", kind: "summary", sessionId: "session" }))).status).toBe(200)
    expect(mocks.session).toHaveBeenCalledWith({ studyId: "study", sessionId: "session", kind: "summary", userId: "member" })
  })
  it("returns a safe error without model output or secrets", async () => {
    mocks.synthesis.mockRejectedValue(new Error("secret"))
    const response = await POST(request({ studyId: "study", kind: "synthesis" }))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("secret")
  })
})
