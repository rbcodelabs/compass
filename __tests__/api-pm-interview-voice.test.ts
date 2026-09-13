import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const pmInterviewVoiceContext = vi.hoisted(() => vi.fn())
const createResearchVoiceLease = vi.hoisted(() => vi.fn())
const releaseResearchVoiceLease = vi.hoisted(() => vi.fn())
const verifyParticipantVoiceLease = vi.hoisted(() => vi.fn())
const appendParticipantVoiceEvent = vi.hoisted(() => vi.fn())
const markPmInterviewSpeechPending = vi.hoisted(() => vi.fn())
vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/pm-interview-service", () => ({
  PmInterviewError: class PmInterviewError extends Error { constructor(message: string, readonly status = 422) { super(message) } },
  pmInterviewVoiceContext,
  markPmInterviewSpeechPending,
}))
vi.mock("@/lib/research-voice", () => ({
  ResearchVoiceError: class ResearchVoiceError extends Error { constructor(message: string, readonly status: number) { super(message) } },
  createResearchVoiceLease,
  releaseResearchVoiceLease,
}))
vi.mock("@/lib/research-participant-voice", () => ({ verifyParticipantVoiceLease, appendParticipantVoiceEvent }))

import { POST as provision } from "@/app/api/pm-interviews/[interviewId]/voice-session/route"
import { POST as event } from "@/app/api/pm-interviews/[interviewId]/voice-event/route"

const params = { params: Promise.resolve({ interviewId: "interview-1" }) }
function request(path: string, body: unknown) { return new Request(`http://localhost${path}?orgSlug=acme&workspaceSlug=product`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }

describe("authenticated PM interview voice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "owner-1" } })
    pmInterviewVoiceContext.mockResolvedValue({ prisma: {}, study: { id: "study-1", targetMinutes: 15 }, participantToken: { id: "internal-token-row" }, interview: { id: "interview-1" } })
    createResearchVoiceLease.mockResolvedValue({ leaseId: "lease-1", expiresAt: new Date("2026-09-11T13:00:00Z"), instructions: "PM ONLY" })
    appendParticipantVoiceEvent.mockResolvedValue({ replayed: false, turn: { id: "turn-1" } })
    markPmInterviewSpeechPending.mockResolvedValue({ version: 1, phase: "SPEECH_PENDING", leaseId: "lease-1", speechId: "input:item-1", at: "2026-09-11T12:00:00.000Z" })
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("COMPASS_RESEARCH_BROWSER_VOICE_ENABLED", "1")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    vi.stubEnv("NODE_ENV", "development")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("provisions the deterministic realtime fixture without exposing an internal participant token", async () => {
    const response = await provision(request("/api/pm-interviews/interview-1/voice-session", { sessionId: "session-1", resumeToken: "resume-secret" }), params)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ephemeralToken: "e2e-no-provider", leaseId: "lease-1", evidenceMode: "PARTICIPANT_SUBMITTED" })
    expect(JSON.stringify(body)).not.toContain("internal-token-row")
    expect(createResearchVoiceLease).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", resumeToken: "resume-secret" }))
  })

  it("rejects public-token and provider overrides on the authenticated provisioning route", async () => {
    const response = await provision(request("/api/pm-interviews/interview-1/voice-session", { sessionId: "session-1", resumeToken: "resume-secret", token: "copied-public-token", model: "other" }), params)
    expect(response.status).toBe(400)
    expect(createResearchVoiceLease).not.toHaveBeenCalled()
  })

  it("persists ordered finalized turns through the established participant lease writer", async () => {
    const response = await event(request("/api/pm-interviews/interview-1/voice-event", { sessionId: "session-1", resumeToken: "resume-secret", leaseId: "lease-1", action: "FINAL", clientEventId: "client-1", reportedOrdinal: 0, role: "PARTICIPANT", content: "I believe onboarding is unclear" }), params)
    expect(response.status).toBe(200)
    expect(appendParticipantVoiceEvent).toHaveBeenCalledWith(expect.objectContaining({ leaseId: "lease-1", reportedOrdinal: 0, role: "PARTICIPANT" }))
  })

  it("records browser speech start durably against the exact lease", async () => {
    const response = await event(request("/api/pm-interviews/interview-1/voice-event", { sessionId: "session-1", resumeToken: "resume-secret", leaseId: "lease-1", action: "SPEECH_START", speechId: "input:item-1" }), params)
    expect(response.status).toBe(200)
    expect(markPmInterviewSpeechPending).toHaveBeenCalledWith({ orgSlug: "acme", workspaceSlug: "product" }, { userId: "owner-1" }, "interview-1", { leaseId: "lease-1", speechId: "input:item-1" })
    expect(pmInterviewVoiceContext).not.toHaveBeenCalled()
  })

  it("rejects client-supplied settlement counters and receipts", async () => {
    const response = await event(request("/api/pm-interviews/interview-1/voice-event", { sessionId: "session-1", resumeToken: "resume-secret", leaseId: "lease-1", action: "SETTLE", settlement: "FINALIZED", finalizedEventCount: 999 }), params)
    expect(response.status).toBe(400)
    expect(markPmInterviewSpeechPending).not.toHaveBeenCalled()
  })

  it("requires a signed-in user before resolving internal voice context", async () => {
    auth.mockResolvedValue(null)
    const response = await provision(request("/api/pm-interviews/interview-1/voice-session", { sessionId: "session-1", resumeToken: "resume-secret" }), params)
    expect(response.status).toBe(401)
    expect(pmInterviewVoiceContext).not.toHaveBeenCalled()
  })
})
