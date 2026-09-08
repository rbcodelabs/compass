import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const runResearchInterviewAgent = vi.hoisted(() => vi.fn())
const respondToResearchSession = vi.hoisted(() => vi.fn())
const storage = vi.hoisted(() => ({ get: vi.fn() }))
const after = vi.hoisted(() => vi.fn())

vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after }))

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
vi.mock("@/lib/artifact-storage", () => ({ getResearchArtifactStorage: () => storage }))

import { POST } from "@/app/api/research/respond/route"
import { ResearchAgentUnavailableError } from "@/lib/research-agent"

function request(stream = false) {
  return new Request("http://localhost/api/research/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(stream ? { Accept: "application/x-ndjson" } : {}) },
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

  it("streams provisional text and emits final only after the canonical service commits", async () => {
    respondToResearchSession.mockImplementation(async ({ onDelta }) => {
      onDelta("What ")
      onDelta("happened?")
      return { message: "What happened?", turn: { id: "turn-1", role: "INTERVIEWER", content: "What happened?", sequence: 2 }, replayed: false }
    })
    const response = await POST(request(true))
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { type: "delta", text: "What " }, { type: "delta", text: "happened?" },
      { type: "final", result: { message: "What happened?", turn: { id: "turn-1", role: "INTERVIEWER", content: "What happened?", sequence: 2 }, replayed: false } },
    ])
  })

  it("never emits a final after provisional output followed by failed persistence", async () => {
    respondToResearchSession.mockImplementation(async ({ onDelta }) => {
      onDelta("Not yet saved")
      throw new Error("private database diagnostic")
    })
    const response = await POST(request(true))
    const text = await response.text()
    expect(text).toContain('"type":"delta"')
    expect(text).toContain('"type":"error"')
    expect(text).not.toContain('"type":"final"')
    expect(text).not.toContain("private database diagnostic")
  })

  it("returns only the saved receipt on an idempotent stream replay", async () => {
    respondToResearchSession.mockResolvedValue({ message: "Saved", turn: { id: "turn-1", role: "INTERVIEWER", content: "Saved", sequence: 2 }, replayed: true })
    const text = await (await POST(request(true))).text()
    expect(text.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(text)).toMatchObject({ type: "final", result: { replayed: true } })
    expect(runResearchInterviewAgent).not.toHaveBeenCalled()
  })

  it("does not let a disconnected reader throw into a later successful save", async () => {
    let finish!: () => void
    let emit!: (text: string) => void
    respondToResearchSession.mockImplementation(async ({ onDelta }) => {
      emit = onDelta
      await new Promise<void>((resolve) => { finish = resolve })
      return { message: "Saved", replayed: false }
    })
    const response = await POST(request(true))
    expect(after).toHaveBeenCalledOnce()
    const registered = after.mock.calls[0][0] as Promise<void>
    expect(registered).toBeInstanceOf(Promise)
    let settled = false
    void registered.then(() => { settled = true })
    await response.body!.cancel()
    expect(() => emit("After disconnect")).not.toThrow()
    expect(settled).toBe(false)
    finish()
    await registered
    expect(settled).toBe(true)
    expect(respondToResearchSession).toHaveBeenCalledOnce()
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

  it("forwards private attachment bytes from session handling into the paid interviewer", async () => {
    const attachments = [{
      mimeType: "image/png" as const,
      originalName: "study-create.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }, {
      mimeType: "application/pdf" as const,
      originalName: "study-notes.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    }]
    runResearchInterviewAgent.mockResolvedValue("What on this screen felt unclear?")
    respondToResearchSession.mockImplementation(async ({ runAgent }: {
      runAgent: (input: { prompt: string; baseUrl: string; attachments: typeof attachments }) => Promise<string>
    }) => ({
      message: await runAgent({
        prompt: "moderate the next turn",
        baseUrl: "https://compass.test",
        attachments,
      }),
      replayed: false,
    }))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(runResearchInterviewAgent).toHaveBeenCalledWith({
      prompt: "moderate the next turn",
      baseUrl: "https://compass.test",
      attachments,
    })
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
