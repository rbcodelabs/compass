// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchChat } from "@/components/research/research-chat"

describe("ResearchChat", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    }
    vi.stubGlobal("localStorage", storage)
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows a retryable error when the interviewer cannot answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: "session-1",
        resumeToken: "resume-secret",
        status: "IN_PROGRESS",
        turns: [{ id: "turn-1", role: "INTERVIEWER", content: "Tell me about the last time you planned your week.", sequence: 0 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "Interviewer is not configured",
      }), { status: 503, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    expect(await screen.findByText("Tell me about the last time you planned your week.")).toBeVisible()

    fireEvent.change(screen.getByRole("textbox", { name: "Your response" }), {
      target: { value: "I use a spreadsheet." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("This interview isn’t available yet")
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(screen.getByText("I use a spreadsheet.")).toBeVisible()

    const firstRespondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(firstRespondBody).toMatchObject({
      token: "study-token",
      sessionId: "session-1",
      resumeToken: "resume-secret",
      answer: "I use a spreadsheet.",
      idempotencyKey: expect.any(String),
    })
    expect(firstRespondBody).not.toHaveProperty("messages")
    expect(firstRespondBody).not.toHaveProperty("elapsedSeconds")
  })

  it("resumes canonical persisted turns after a reload", async () => {
    localStorage.setItem("compass-research-session-study-token", JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
      status: "IN_PROGRESS",
      turns: [
        { id: "turn-1", role: "INTERVIEWER", content: "Opening question", sequence: 0 },
        { id: "turn-2", role: "PARTICIPANT", content: "Persisted answer", sequence: 1 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    render(<ResearchChat token="study-token" />)

    expect(await screen.findByText("Persisted answer")).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith("/api/research/start", expect.objectContaining({
      body: JSON.stringify({ token: "study-token", sessionId: "session-1", resumeToken: "resume-secret" }),
    }))
    expect(screen.queryByRole("button", { name: "Start interview" })).not.toBeInTheDocument()
  })

  it("clears the participant resume secret after successful completion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: "session-1",
        resumeToken: "resume-secret",
        status: "IN_PROGRESS",
        turns: [{ id: "turn-1", role: "INTERVIEWER", content: "Opening", sequence: 0 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "COMPLETED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    expect(await screen.findByText("Opening")).toBeVisible()
    expect(localStorage.getItem("compass-research-session-study-token")).toContain("resume-secret")

    fireEvent.click(screen.getByRole("button", { name: "Finish interview" }))

    expect(await screen.findByText("Thank you")).toBeVisible()
    expect(localStorage.getItem("compass-research-session-study-token")).toBeNull()
  })

  it("clears stored credentials and does not render prior answers when resume is already complete", async () => {
    localStorage.setItem("compass-research-session-study-token", JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
    }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
      status: "COMPLETED",
      turns: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })))

    render(<ResearchChat token="study-token" />)

    expect(await screen.findByText("Thank you")).toBeVisible()
    expect(localStorage.getItem("compass-research-session-study-token")).toBeNull()
    expect(screen.queryByText("Persisted answer")).not.toBeInTheDocument()
  })
})
