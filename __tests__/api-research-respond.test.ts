import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))

import { POST } from "@/app/api/research/respond/route"

function request() {
  return new Request("http://localhost/api/research/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "study-token",
      sessionId: "session-1",
      elapsedSeconds: 30,
      messages: [
        { role: "INTERVIEWER", content: "Tell me about the last time." },
        { role: "PARTICIPANT", content: "Yesterday I used a spreadsheet." },
      ],
    }),
  })
}

describe("research interviewer response", () => {
  beforeEach(() => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: {
        id: "study-1",
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
    vi.stubEnv("OPENAI_API_KEY", "")

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "Interviewer is not configured" })
  })

  it("returns the adaptive interviewer reply", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const modelFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "What made the spreadsheet difficult to use?" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", modelFetch)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      message: "What made the spreadsheet difficult to use?",
    })
    const modelRequest = JSON.parse(modelFetch.mock.calls[0][1].body as string)
    expect(modelRequest.messages[0].content).toContain("Understand planning habits")
  })
})
