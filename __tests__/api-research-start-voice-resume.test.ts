import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const startOrResumeResearchSession = vi.hoisted(() => vi.fn())

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("@/lib/research-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/research-session")>(),
  startOrResumeResearchSession,
}))

import { POST } from "@/app/api/research/start/route"
import { ResearchSessionError } from "@/lib/research-session"

describe("research start voice-resume gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_BROWSER_VOICE_ENABLED", "")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "")
    vi.stubEnv("E2E_FUNCTIONAL", "")
    resolveActiveResearchStudy.mockResolvedValue({ study: { id: "study-1" } })
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ["new", { token: "study-token", modality: "VOICE" }, undefined],
    ["resumed", { token: "study-token", sessionId: "voice-session-1", resumeToken: "resume-secret", modality: "VOICE" }, { sessionId: "voice-session-1", resumeToken: "resume-secret" }],
  ])("admits a %s browser voice session in production without the legacy authoritative flag", async (_label, body, resume) => {
    vi.stubEnv("COMPASS_RESEARCH_BROWSER_VOICE_ENABLED", "1")
    startOrResumeResearchSession.mockResolvedValue({ sessionId: "voice-session-1", status: "IN_PROGRESS", turns: [] })

    const response = await POST(new Request("http://localhost/api/research/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }))

    expect(response.status).toBe(200)
    expect(startOrResumeResearchSession).toHaveBeenCalledWith(expect.anything(), resume, "VOICE")
  })

  it("keeps browser voice admission closed when both participant voice paths are disabled", async () => {
    const response = await POST(new Request("http://localhost/api/research/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "study-token", modality: "VOICE" }),
    }))

    expect(response.status).toBe(409)
    expect(resolveActiveResearchStudy).not.toHaveBeenCalled()
    expect(startOrResumeResearchSession).not.toHaveBeenCalled()
  })

  it("resolves an invalid token after production browser voice admission", async () => {
    vi.stubEnv("COMPASS_RESEARCH_BROWSER_VOICE_ENABLED", "1")
    resolveActiveResearchStudy.mockResolvedValue(null)

    const response = await POST(new Request("http://localhost/api/research/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid-token", modality: "VOICE" }),
    }))

    expect(response.status).toBe(404)
    expect(startOrResumeResearchSession).not.toHaveBeenCalled()
  })

  it("surfaces the domain rejection when a voice resume omits modality", async () => {
    startOrResumeResearchSession.mockRejectedValue(new ResearchSessionError("Voice is not available for this study", 409))
    const response = await POST(new Request("http://localhost/api/research/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "study-token", sessionId: "voice-session-1", resumeToken: "resume-secret" }),
    }))

    expect(response.status).toBe(409)
    expect(startOrResumeResearchSession).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: "voice-session-1", resumeToken: "resume-secret" },
      "CHAT",
    )
  })
})
