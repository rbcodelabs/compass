import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const runResearchInterviewAgent = vi.hoisted(() => vi.fn())
const respondToResearchSession = vi.hoisted(() => vi.fn())
const storage = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("@/lib/research-agent", () => ({
  ResearchAgentUnavailableError: class ResearchAgentUnavailableError extends Error {},
  runResearchInterviewAgent,
}))
vi.mock("@/lib/research-session", () => ({
  ResearchSessionError: class ResearchSessionError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  },
  respondToResearchSession,
}))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))

import { POST } from "@/app/api/research/respond/route"
import { ResearchAgentUnavailableError } from "@/lib/research-agent"

function request() {
  return new Request("http://localhost/api/research/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "study-token",
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Yesterday I used a spreadsheet.",
    }),
  })
}

describe("research interviewer response", () => {
  beforeEach(() => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: {
        id: "study-1",
        workspaceId: "workspace-1",
        createdById: "user-1",
        guide: JSON.stringify([{ id: "1", text: "Tell me about the last time." }]),
        goal: "Understand planning habits",
        targetMinutes: 15,
      },
      prisma: {
        researchSession: {
          findFirst: vi.fn().mockResolvedValue({ id: "session-1" }),
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("reports a missing model credential instead of silently failing", async () => {
    respondToResearchSession.mockRejectedValue(
      new ResearchAgentUnavailableError("ANTHROPIC_API_KEY is not configured"),
    )

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "Interviewer is not configured" })
  })

  it("returns the adaptive interviewer reply", async () => {
    respondToResearchSession.mockResolvedValue({
      message: "What made the spreadsheet difficult to use?",
      replayed: false,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      message: "What made the spreadsheet difficult to use?",
      replayed: false,
    })
    expect(respondToResearchSession).toHaveBeenCalledWith(expect.objectContaining({
      answer: "Yesterday I used a spreadsheet.",
      idempotencyKey: "clientturnid0001",
      resumeToken: "resume-secret",
    }))
  })

  it("forwards only attachment IDs and a private byte loader to canonical session handling", async () => {
    respondToResearchSession.mockResolvedValue({ message: "What did you expect?", replayed: false })
    const body = {
      token: "study-token", sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001", answer: "This was confusing.",
      attachmentIds: ["00000000-0000-4000-8000-000000000001"],
    }
    const response = await POST(new Request("http://localhost/api/research/respond", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }))
    expect(response.status).toBe(200)
    expect(respondToResearchSession).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: body.attachmentIds,
      loadAttachmentBytes: expect.any(Function),
    }))
  })

  it("uses a deterministic no-cost agent only for local functional E2E", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    respondToResearchSession.mockImplementation(async ({ runAgent }: { runAgent: (input: { prompt: string; baseUrl: string }) => Promise<string> }) => ({
      message: await runAgent({ prompt: "prompt", baseUrl: "http://localhost" }),
      replayed: false,
    }))

    const response = await POST(request())

    await expect(response.json()).resolves.toMatchObject({ message: "What made that difficult for you?" })
    expect(runResearchInterviewAgent).not.toHaveBeenCalled()
  })

  it("cannot bypass the real agent in production even when the E2E flag is present", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    runResearchInterviewAgent.mockResolvedValue("Production model reply")
    respondToResearchSession.mockImplementation(async ({ runAgent }: { runAgent: (input: { prompt: string; baseUrl: string }) => Promise<string> }) => ({
      message: await runAgent({ prompt: "prompt", baseUrl: "https://compass.test" }),
      replayed: false,
    }))

    const response = await POST(request())

    await expect(response.json()).resolves.toMatchObject({ message: "Production model reply" })
    expect(runResearchInterviewAgent).toHaveBeenCalledOnce()
  })
})
