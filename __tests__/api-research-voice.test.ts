import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const createResearchVoiceLease = vi.hoisted(() => vi.fn())
const appendFinalResearchVoiceEvent = vi.hoisted(() => vi.fn())
const releaseResearchVoiceLease = vi.hoisted(() => vi.fn())

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("@/lib/research-voice", () => ({
  ResearchVoiceError: class ResearchVoiceError extends Error { constructor(message: string, readonly status: number) { super(message) } },
  createResearchVoiceLease,
  appendFinalResearchVoiceEvent,
  releaseResearchVoiceLease,
}))

import { POST as createVoice } from "@/app/api/research/voice-session/route"
import { POST as persistVoice } from "@/app/api/research/voice-event/route"

function request(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
}

describe("research voice APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("OPENAI_API_KEY", "long-lived-secret")
    resolveActiveResearchStudy.mockResolvedValue({ study: { id: "study-1" }, prisma: {} })
    createResearchVoiceLease.mockResolvedValue({
      leaseId: "lease-1", expiresAt: new Date("2026-08-30T12:02:00Z"), instructions: "SERVER GUIDED INSTRUCTIONS",
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it("mints only a short-lived tool-free realtime credential from server-authored policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: "ephemeral-secret", expires_at: 123 }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const response = await createVoice(request("/api/research/voice-session", {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret",
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ephemeralToken: "ephemeral-secret", leaseId: "lease-1" })
    const providerBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(providerBody.session).toMatchObject({
      type: "realtime", model: expect.any(String), instructions: "SERVER GUIDED INSTRUCTIONS", tools: [],
      audio: { input: { transcription: { model: expect.any(String) } }, output: { voice: expect.any(String) } },
    })
    expect(JSON.stringify(providerBody)).not.toContain("resume-secret")
  })

  it("rejects client model, prompt, voice, or tool overrides", async () => {
    const response = await createVoice(request("/api/research/voice-session", {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret", model: "cheap", tools: ["mcp"],
    }))
    expect(response.status).toBe(400)
    expect(createResearchVoiceLease).not.toHaveBeenCalled()
  })

  it("keeps deterministic functional E2E voice events off the paid provider", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await createVoice(request("/api/research/voice-session", {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret",
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ephemeralToken: "e2e-no-provider", leaseId: "lease-1" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("persists one finalized provider event and rejects full-transcript replacement", async () => {
    appendFinalResearchVoiceEvent.mockResolvedValue({ replayed: false, turn: { id: "turn-1" } })
    const response = await persistVoice(request("/api/research/voice-event", {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret", leaseId: "lease-1",
      action: "FINAL", providerEventId: "provider-1", role: "PARTICIPANT", content: "I expected pricing here.",
    }))
    expect(response.status).toBe(200)
    expect(appendFinalResearchVoiceEvent).toHaveBeenCalledOnce()

    const rejected = await persistVoice(request("/api/research/voice-event", {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret", leaseId: "lease-1",
      action: "FINAL", providerEventId: "provider-2", role: "PARTICIPANT", content: "x", transcript: [],
    }))
    expect(rejected.status).toBe(400)
  })
})
