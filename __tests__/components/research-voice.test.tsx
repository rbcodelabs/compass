// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchVoice } from "@/components/research/research-voice"

class FakeDataChannel extends EventTarget { send = vi.fn(); close = vi.fn() }
const channel = new FakeDataChannel()
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
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection)
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-1", resumeToken: "resume-secret", status: "IN_PROGRESS", turns: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ephemeralToken: "short-secret", leaseId: "lease-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("answer-sdp", { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it("connects with an ephemeral credential and persists finalized events incrementally", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    expect(await screen.findByText("Connected — think aloud as you work")).toBeVisible()
    expect(fetch).toHaveBeenNthCalledWith(3, "https://api.openai.com/v1/realtime/calls", expect.objectContaining({
      method: "POST", body: "offer-sdp", headers: expect.objectContaining({ Authorization: "Bearer short-secret", "Content-Type": "application/sdp" }),
    }))

    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-1", transcript: "I expected pricing here." }) }))
    expect(await screen.findByText("I expected pricing here.")).toBeVisible()
    expect(fetch).toHaveBeenCalledWith("/api/research/voice-event", expect.objectContaining({ body: expect.stringContaining('"providerEventId":"input:user-1"') }))
  })

  it("uploads a screenshot, links it to the canonical transcript, and shares bytes with realtime", async () => {
    render(<ResearchVoice token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }))
    await screen.findByText("Connected — think aloud as you work")
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
})
