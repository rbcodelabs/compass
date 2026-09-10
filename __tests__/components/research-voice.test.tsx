// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

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
      status: "READY", kind: "SCREENSHOT",
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

  it.each(["image/gif", "image/heic"])("preserves %s without sending its bytes to realtime", async (mimeType) => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "00000000-0000-4000-8000-000000000009", originalName: "original", mimeType, sizeBytes: 4 }))
    fireEvent.change(screen.getByLabelText("Share screenshot or PDF"), { target: { files: [new File(["data"], "original", { type: mimeType })] } })
    await waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.stringContaining("not sent")))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('"input_image"'))
    expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"attachmentId"') }))
  })

  it("restores a private HEIC download from saved voice attachment metadata", async () => {
    URL.createObjectURL = vi.fn(() => "blob:voice-evidence")
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [{ id: "saved", role: "PARTICIPANT", content: "Shared photo", attachments: [{ id: "attachment-1", originalName: "photo.heic", mimeType: "image/heic", sizeBytes: 4 }] }] }))
      .mockResolvedValueOnce(Response.json({ ephemeralToken: "short-secret", leaseId: "lease-1" }))
      .mockResolvedValueOnce(new Response("answer-sdp"))
      .mockResolvedValue(new Response("heic", { headers: { "Content-Type": "image/heic" } })))
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    expect(await screen.findByRole("link", { name: "photo.heic" })).toHaveAttribute("download", "photo.heic")
    expect(fetch).toHaveBeenCalledWith("/api/research/attachments/attachment-1", expect.objectContaining({ method: "POST", body: expect.stringContaining("resume-secret") }))
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

  it("mutes capture while waiting for a late semantic final caption before completing", async () => {
    const track = { enabled: true, stop: stopTrack }
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream)
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }))
    expect(track.enabled).toBe(false)
    expect(stopTrack).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    act(() => channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) })))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(fetch).not.toHaveBeenCalledWith("/api/research/complete", expect.anything())
    act(() => channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", item_id: "final-answer", transcript: "I needed time to finish this thought.",
    }) })))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining("I needed time to finish this thought.") }))
    expect(fetch).toHaveBeenCalledWith("/api/research/complete", expect.anything())
    expect(stopTrack).toHaveBeenCalled()
    expect(screen.getByRole("heading", { name: "Thank you" })).toBeVisible()
  })

  it("stops the microphone after a bounded drain and refuses completion when a final caption never arrives", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — speak naturally")
    vi.useFakeTimers()
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta", item_id: "unfinished", delta: "Still speaking",
    }) }))
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(stopTrack).toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("not marked complete")
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
      expect(await screen.findByRole("alert")).toHaveTextContent("timed out")
      expect(stopTrack).toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { timeout.mockRestore() }
  })

  it.each(["createOffer", "setRemoteDescription"] as const)("stops owned media when %s stalls and rejects late readiness", async (stage) => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error("Startup deadline exceeded")), milliseconds)
      return controller.signal
    })
    let resolveStage!: (value?: unknown) => void
    peer[stage].mockImplementationOnce(() => new Promise((resolve) => { resolveStage = resolve }))
    try {
      render(<ResearchVoice token="study-token" />)
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start voice session" })) })
      expect(peer[stage]).toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
      expect(stopTrack).toHaveBeenCalled()
      expect(peer.close).toHaveBeenCalled()
      expect(screen.getByRole("alert")).toHaveTextContent("timed out")
      expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"action":"DISCONNECT"') }))
      vi.mocked(fetch).mockImplementation(async (url) => {
        if (url === "/api/research/start") return Response.json({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] })
        if (url === "/api/research/voice-session") return Response.json({ ephemeralToken: "new-short-secret", leaseId: "lease-2" })
        return new Response("answer-sdp", { status: 200 })
      })
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconnect voice session" })) })
      expect(screen.getByText("Connected — speak naturally")).toBeVisible()
      const closes = peer.close.mock.calls.length
      await act(async () => { resolveStage({ type: "offer", sdp: "late-offer" }) })
      expect(screen.getByText("Connected — speak naturally")).toBeVisible()
      expect(peer.close).toHaveBeenCalledTimes(closes)
    } finally { cleanup(); timeout.mockRestore(); vi.useRealTimers() }
  })

  it("stops a microphone permission result arriving after the startup deadline", async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    let resolveMedia!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void
    const getUserMedia = vi.fn(() => new Promise((resolve) => { resolveMedia = resolve }))
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } })
    try {
      render(<ResearchVoice token="study-token" />)
      fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
      deadline.abort()
      expect(await screen.findByRole("alert")).toHaveTextContent("timed out")
      await act(async () => { resolveMedia({ getTracks: () => [{ stop: stopTrack }] }) })
      expect(stopTrack).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  })

  it("uses think-aloud copy only for guided usability voice", () => {
    render(<ResearchVoice guided token="study-token" />)
    expect(screen.getByRole("heading", { name: "Voice think-aloud" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Voice interview" })).not.toBeInTheDocument()
  })
})
