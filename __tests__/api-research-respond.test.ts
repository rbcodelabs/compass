import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const runResearchInterviewAgent = vi.hoisted(() => vi.fn())

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("@/lib/research-agent", () => ({
  ResearchAgentUnavailableError: class ResearchAgentUnavailableError extends Error {},
  runResearchInterviewAgent,
}))

import { POST } from "@/app/api/research/respond/route"
import { ResearchAgentUnavailableError } from "@/lib/research-agent"

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
    runResearchInterviewAgent.mockRejectedValue(
      new ResearchAgentUnavailableError("ANTHROPIC_API_KEY is not configured"),
    )

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "Interviewer is not configured" })
  })

  it("returns the adaptive interviewer reply", async () => {
    runResearchInterviewAgent.mockResolvedValue("What made the spreadsheet difficult to use?")

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      message: "What made the spreadsheet difficult to use?",
    })
    expect(runResearchInterviewAgent).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      workspaceId: "workspace-1",
      prompt: expect.stringContaining("Understand planning habits"),
    }))
  })
})
