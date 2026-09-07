// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchChat } from "@/components/research/research-chat"
import { StrictMode } from "react"

function savedReply(message: string) {
  return { message, turn: { id: "interviewer-1", role: "INTERVIEWER", content: message, sequence: 2 }, replayed: false }
}

describe("ResearchChat", () => {
  it("explains how to recover when a browser supplies no HEIC MIME type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ sessionId: "session-1", resumeToken: "secret", status: "IN_PROGRESS", turns: [] })))
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File(["abc"], "photo.heic")] } })
    expect(await screen.findByRole("alert")).toHaveTextContent(/another browser/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(["image/gif", "image/heic"])("allows uploading preserved %s evidence", async (mimeType) => {
    URL.createObjectURL = vi.fn(() => "blob:pending")
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "session-1", resumeToken: "secret", status: "IN_PROGRESS", turns: [] }))
      .mockResolvedValueOnce(Response.json({ id: "attachment-1", originalName: "original", mimeType, sizeBytes: 3 })))
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File(["abc"], "original", { type: mimeType })] } })
    expect(await screen.findByRole("link", { name: "original" })).toHaveAttribute("download", "original")
    expect(fetch).toHaveBeenCalledWith("/api/research/attachments", expect.objectContaining({ method: "POST" }))
  })
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
    expect(screen.getByRole("button", { name: "Finish interview" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Finish interview" }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem("compass-research-session-study-token-pending")).not.toBeNull()
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

    render(<StrictMode><ResearchChat token="study-token" /></StrictMode>)

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

  it("uses a multiline composer and does not send on Shift+Enter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
    vi.stubGlobal("fetch", fetchMock)
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    const input = await screen.findByRole("textbox", { name: "Your response" })
    expect(input.tagName).toBe("TEXTAREA")
    fireEvent.change(input, { target: { value: "First\nSecond" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("lets the participant dismiss an invalid upload and continue typing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }))))
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    const input = await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] } })
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a PNG")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }))
    expect(input).toBeEnabled()
  })

  it("accepts dropped evidence and sends an attachment-only answer with a saved preview", async () => {
    const attachment = { id: "00000000-0000-4000-8000-000000000001", originalName: "evidence.png", mimeType: "image/png", sizeBytes: 3 }
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(attachment)))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedReply("What does this show?"))))
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } })))
    URL.createObjectURL = vi.fn().mockReturnValue("blob:private-preview")
    URL.revokeObjectURL = vi.fn()
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    const input = await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.drop(input, { dataTransfer: { files: [new File(["abc"], "evidence.png", { type: "image/png" })], types: ["Files"] } })
    await waitFor(() => expect(screen.getByText("evidence.png")).toBeVisible())
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await screen.findByText("What does this show?")
    expect(vi.mocked(fetch).mock.calls[2][1]?.body).toContain('"answer":""')
    expect(await screen.findByRole("img", { name: "evidence.png" })).toHaveAttribute("src", "blob:private-preview")
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/research/attachments/${attachment.id}`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ token: "study-token", sessionId: "session-1", resumeToken: "resume-secret" }),
    })))
    cleanup()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-preview")
  })

  it("shows provisional text separately, discards it on failure, and retries the same request", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
      .mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedReply("Saved retry"))))
    vi.stubGlobal("fetch", fetchMock)
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Your response" }), { target: { value: "An answer" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await act(async () => { controller.enqueue(new TextEncoder().encode('{"type":"delta","text":"Unsaved question"}\n')) })
    expect(await screen.findByText("Unsaved question")).toBeVisible()
    expect(screen.getByText(/not saved yet/i)).toBeVisible()
    await act(async () => { controller.enqueue(new TextEncoder().encode('{"type":"error","status":502}\n')); controller.close() })
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled()
    expect(screen.queryByText("Unsaved question")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await screen.findByText("Saved retry")
    expect(fetchMock.mock.calls[1][1].body).toEqual(fetchMock.mock.calls[2][1].body)
  })

  it.each([
    ["customer interview", false, "Start interview"],
    ["guided usability", true, "Start session"],
  ])("uploads evidence in a %s and links its ID to the next answer", async (_label, guided, startLabel) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", status: "READY", originalName: "screen.png", mimeType: "image/png", sizeBytes: 3 }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedReply("What did you expect?")), { status: 200, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    render(<ResearchChat guided={guided} token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: startLabel }))
    await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" })] } })
    await waitFor(() => expect(screen.getByText("screen.png")).toBeVisible())
    fireEvent.change(screen.getByRole("textbox", { name: "Your response" }), { target: { value: "This was confusing." } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await screen.findByText("What did you expect?")
    const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(startBody.modality).toBe("CHAT")
    const respondBody = JSON.parse(fetchMock.mock.calls[2][1].body as string)
    expect(respondBody.attachmentIds).toEqual(["00000000-0000-4000-8000-000000000001"])
  })

  it.each(["Saved answer", ("a\n").repeat(1999) + "a"])("restores the original request key including escaped answers %#", async (answer) => {
    localStorage.setItem("compass-research-session-study-token", JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret" }))
    const pending = { answer, idempotencyKey: "originalrequest1234", attachmentIds: [] }
    localStorage.setItem("compass-research-session-study-token-pending", JSON.stringify({ sessionId: "session-1", request: pending, expiresAt: Date.now() + 60_000 }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [{ id: "p-1", role: "PARTICIPANT", content: answer, sequence: 1 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedReply("Recovered final"))))
    vi.stubGlobal("fetch", fetchMock)
    render(<ResearchChat token="study-token" />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    await screen.findByText("Recovered final")
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject(pending)
    expect(screen.getAllByText(answer, { normalizer: (value) => value })).toHaveLength(1)
    expect(localStorage.getItem("compass-research-session-study-token-pending")).toBeNull()
  })

  it("does not finish while a private evidence upload is unresolved", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
      .mockImplementationOnce(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetchMock)
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    await screen.findByRole("textbox", { name: "Your response" })
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File(["abc"], "screen.png", { type: "image/png" })] } })
    expect(screen.getByRole("button", { name: "Finish interview" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Finish interview" }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([-1, 3 * 60 * 60 * 1000])("purges pending recovery outside the session retention window (%i)", async (offset) => {
    localStorage.setItem("compass-research-session-study-token", JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret" }))
    localStorage.setItem("compass-research-session-study-token-pending", JSON.stringify({ sessionId: "session-1", expiresAt: Date.now() + offset, request: { answer: "Private", idempotencyKey: "originalrequest1234", attachmentIds: [] } }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }))))
    render(<ResearchChat token="study-token" />)
    await screen.findByRole("textbox", { name: "Your response" })
    expect(localStorage.getItem("compass-research-session-study-token-pending")).toBeNull()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
  })

  it("purges pending answer when its stored session is rejected", async () => {
    localStorage.setItem("compass-research-session-study-token", JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret" }))
    localStorage.setItem("compass-research-session-study-token-pending", JSON.stringify({ sessionId: "session-1", expiresAt: Date.now() + 60_000, request: { answer: "Private", idempotencyKey: "originalrequest1234", attachmentIds: [] } }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })))
    render(<ResearchChat token="study-token" />)
    await screen.findByRole("alert")
    expect(localStorage.getItem("compass-research-session-study-token-pending")).toBeNull()
  })

  it("purges expired pending recovery even when its resume credential is gone", async () => {
    localStorage.setItem("compass-research-session-study-token-pending", JSON.stringify({ sessionId: "session-1", expiresAt: Date.now() - 1, request: { answer: "Private", idempotencyKey: "originalrequest1234", attachmentIds: [] } }))
    render(<ResearchChat token="study-token" />)
    await waitFor(() => expect(localStorage.getItem("compass-research-session-study-token-pending")).toBeNull())
  })

  it("removes expired pending text while the participant page stays open", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
        .mockResolvedValueOnce(new Response("{}", { status: 502 })))
      render(<ResearchChat token="study-token" />)
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start interview" })) })
      fireEvent.change(screen.getByRole("textbox", { name: "Your response" }), { target: { value: "Private pending answer" } })
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })) })
      expect(localStorage.getItem("compass-research-session-study-token-pending")).not.toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1) })
      expect(localStorage.getItem("compass-research-session-study-token-pending")).toBeNull()
      expect(screen.getByRole("alert")).toHaveTextContent("recovery window has expired")
    } finally { vi.useRealTimers() }
  })

  it("does not accept a JSON reply without the matching committed turn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Unconfirmed final" }))))
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Your response" }), { target: { value: "Answer" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await screen.findByRole("button", { name: "Try again" })
    expect(screen.queryByText("Unconfirmed final")).not.toBeInTheDocument()
  })

  it("does not delete another tab's newer pending request when an older reply commits", async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve })))
    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Your response" }), { target: { value: "Older answer" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const newer = JSON.stringify({ sessionId: "session-1", expiresAt: Date.now() + 60_000, request: { answer: "Newer answer", idempotencyKey: "newerrequest123456", attachmentIds: [] } })
    localStorage.setItem("compass-research-session-study-token-pending", newer)
    await act(async () => { finish(new Response(JSON.stringify({ message: "Saved", turn: { id: "i-1", role: "INTERVIEWER", content: "Saved", sequence: 2 }, replayed: false }))) })
    await screen.findByText("Saved")
    expect(localStorage.getItem("compass-research-session-study-token-pending")).toBe(newer)
  })
})
