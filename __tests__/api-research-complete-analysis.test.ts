import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ after: vi.fn(), resolve: vi.fn(), complete: vi.fn(), analyze: vi.fn() }))
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }))
vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy: mocks.resolve }))
vi.mock("@/lib/research-session", () => ({ completeResearchSession: mocks.complete, ResearchSessionError: class extends Error {} }))
vi.mock("@/lib/research-analysis-service", () => ({ generateSessionAnalysis: mocks.analyze }))
import { POST } from "@/app/api/research/complete/route"
const request = () => new Request("http://localhost/api/research/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "token", sessionId: "session", resumeToken: "resume" }) })
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ study: { id: "study" } }); mocks.complete.mockResolvedValue({ ok: true, status: "COMPLETED" }); mocks.analyze.mockResolvedValue(null) })
describe("best-effort completion summaries", () => {
  it("schedules only after durable completion and only uses saved IDs", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.after.mock.invocationCallOrder[0])
    await mocks.after.mock.calls[0][0]()
    expect(mocks.analyze).toHaveBeenCalledWith({ studyId: "study", sessionId: "session", kind: "summary", automatic: true })
  })
  it("keeps completion successful if analysis fails", async () => {
    mocks.analyze.mockRejectedValue(new Error("unavailable"))
    const response = await POST(request())
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined()
    expect(await response.json()).toEqual({ ok: true, status: "COMPLETED" })
  })
  it("keeps completion successful if scheduling fails", async () => {
    mocks.after.mockImplementationOnce(() => { throw new Error("No scheduling context") })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.analyze).not.toHaveBeenCalled()
  })
  it("does not schedule analysis for rejected participant credentials", async () => {
    mocks.resolve.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(404)
    expect(mocks.after).not.toHaveBeenCalled()
  })
})
