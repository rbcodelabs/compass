// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchVoice } from "@/components/research/research-voice"

class FakeDataChannel extends EventTarget { readyState = "open"; send = vi.fn(); close = vi.fn() }
const channel = new FakeDataChannel()
const stopTrack = vi.fn()
const peer = {
  createDataChannel: vi.fn(() => channel), addTrack: vi.fn(), createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "offer-sdp" }),
  setLocalDescription: vi.fn(), setRemoteDescription: vi.fn(), close: vi.fn(), ontrack: null,
}
class FakePeerConnection {
  constructor() { return peer }
}

describe("ResearchVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection)
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ephemeralToken: "short-secret", leaseId: "lease-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("answer-sdp", { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it("connects with an ephemeral credential and persists finalized events incrementally", async () => {
    render(<ResearchVoice token="study-token" />)
    expect(screen.getByRole("heading", { name: "Voice interview" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    expect(await screen.findByText("Connected — speak naturally")).toBeVisible()
    expect(fetch).toHaveBeenNthCalledWith(3, "https://api.openai.com/v1/realtime/calls", expect.objectContaining({
      method: "POST", body: "offer-sdp", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: "Bearer short-secret", "Content-Type": "application/sdp" }),
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/research/voice-session", expect.objectContaining({ signal: expect.any(AbortSignal) }))

    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-1", transcript: "I expected pricing here." }) }))
    expect(await screen.findByText("I expected pricing here.")).toBeVisible()
    expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"providerEventId":"input:user-1"') }))
  })

  it("uploads a screenshot, links it to the canonical transcript, and shares bytes with realtime", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000009",
      originalName: "pricing.png",
      mimeType: "image/png",
      sizeBytes: 8,
    }), { status: 200 }))

    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), {
      target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "pricing.png", { type: "image/png" })] },
    })

    expect(await screen.findByText("Shared pricing.png")).toBeVisible()
    expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({
      body: expect.stringContaining('"attachmentId":"00000000-0000-4000-8000-000000000009"'),
    }))
    await waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('"type":"input_image"')))
  })

  it("offers chat fallback after microphone permission fails without starting a session", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockRejectedValue(new Error("Permission denied")) } })
    const onUseChat = vi.fn()
    render(<ResearchVoice token="study-token" onUseChat={onUseChat} />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    expect(await screen.findByRole("button", { name: "Use chat instead" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Use chat instead" }))
    expect(onUseChat).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("offers chat fallback when the realtime provider credential fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Realtime unavailable" }), { status: 503 })))
    const onUseChat = vi.fn()
    render(<ResearchVoice token="study-token" onUseChat={onUseChat} />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    expect(await screen.findByRole("button", { name: "Use chat instead" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Use chat instead" }))
    expect(onUseChat).toHaveBeenCalledOnce()
  })

  it("stops the acquired microphone when a stored session has already completed", async () => {
    localStorage.setItem("compass-research-voice-study-token", JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
    }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      sessionId: "session-1",
      resumeToken: "resume-secret",
      status: "COMPLETED",
      turns: [],
    }), { status: 200 })))

    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))

    expect(await screen.findByRole("heading", { name: "Thank you" })).toBeVisible()
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it("stops a microphone that resolves after the component unmounts", async () => {
    let resolveStream!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void
    const streamPromise = new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => { resolveStream = resolve })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockReturnValue(streamPromise) },
    })
    const view = render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))

    view.unmount()
    resolveStream({ getTracks: () => [{ stop: stopTrack }] })

    await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce())
    expect(fetch).not.toHaveBeenCalled()
  })

  it("retains the lease and failed save until explicit retry, never falsely completes", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }))

    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user-persist-failure",
      transcript: "This must be durable.",
    }) }))

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved")
    expect(stopTrack).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Retry finishing session" })).toBeDisabled()
    expect(fetch).not.toHaveBeenCalledWith("/api/research/complete", expect.anything())
    expect(fetch).not.toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"action":"DISCONNECT"') }))
    fireEvent.click(screen.getByRole("button", { name: "Retry saving transcript" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry finishing session" })).toBeEnabled())
    const saves = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/research/voice-event" && String(init?.body).includes('"action":"FINAL"'))
    expect(saves).toHaveLength(2)
    expect(saves[0][1]?.body).toBe(saves[1][1]?.body)
    fireEvent.click(screen.getByRole("button", { name: "Retry finishing session" }))
    expect(await screen.findByRole("heading", { name: "Thank you" })).toBeVisible()
  })

  it("retries once without stale stored resume credentials", async () => {
    localStorage.setItem("compass-research-voice-study-token", JSON.stringify({
      sessionId: "stale-session",
      resumeToken: "stale-secret",
    }))
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Session not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-2", resumeToken: "fresh-secret", status: "IN_PROGRESS", turns: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ephemeralToken: "short-secret", leaseId: "lease-2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("answer-sdp", { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })))

    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))

    expect(await screen.findByText("Connected — speak naturally")).toBeVisible()
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/research/start", expect.objectContaining({
      body: JSON.stringify({ token: "study-token", modality: "VOICE" }),
    }))
  })

  it("stops the microphone but refuses completion when a final caption never arrives", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta", item_id: "unfinished", delta: "Still speaking",
    }) }))
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }))
    expect(stopTrack).toHaveBeenCalled()
    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent("not marked complete")
    expect(fetch).not.toHaveBeenCalledWith("/api/research/complete", expect.anything())
  })

  it("does not release a lease for reconnect while its final save is still pending", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    let rejectSave!: (error: Error) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((_, reject) => { rejectSave = reject }))
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "delayed", transcript: "Retain this answer" }) }))
    const connectedPeer = peer as typeof peer & { connectionState: string; onconnectionstatechange: () => void }
    connectedPeer.connectionState = "failed"
    connectedPeer.onconnectionstatechange()
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect voice session" }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetch).not.toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"action":"DISCONNECT"') }))
    rejectSave(new Error("save unavailable"))
    expect(await screen.findByRole("button", { name: "Retry saving transcript" })).toBeVisible()
  })

  it("blocks reconnect when a finalized answer is buffered behind an unresolved earlier item", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    for (const event of [
      { type: "conversation.item.added", item: { id: "earlier", role: "user", content: [{ type: "input_audio" }] } },
      { type: "response.output_audio_transcript.done", item_id: "later", transcript: "A finalized later question" },
    ]) channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }))
    const connectedPeer = peer as typeof peer & { connectionState: string; onconnectionstatechange: () => void }
    connectedPeer.connectionState = "failed"
    connectedPeer.onconnectionstatechange()
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect voice session" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unresolved"))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("stops the microphone when a stalled credential request reaches its startup deadline", async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    let requested = false
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        requested = true
        return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("Startup deadline exceeded"))))
      }))
    try {
      render(<ResearchVoice token="study-token" />)
      fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
      await waitFor(() => expect(requested).toBe(true))
      deadline.abort()
      expect(await screen.findByRole("alert")).toHaveTextContent("Startup deadline")
      expect(stopTrack).toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { timeout.mockRestore() }
  })

  it("uses think-aloud copy only for guided usability voice", () => {
    render(<ResearchVoice guided token="study-token" />)
    expect(screen.getByRole("heading", { name: "Voice think-aloud" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Voice interview" })).not.toBeInTheDocument()
  })
})
