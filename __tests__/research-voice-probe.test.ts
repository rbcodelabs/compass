import { describe, expect, it, vi } from "vitest"
import { probePolicy, ProbeProtocol } from "@/scripts/research-voice/protocol"
import { Sandbox } from "@vercel/sandbox"
import { ProbeJournal, singleDispatchFetch } from "@/scripts/research-voice/journal"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeProbe, type ProbeAdapters } from "@/scripts/research-voice/lifecycle"
import { stopWorkerProvider, observeProbeSocket } from "@/scripts/research-voice/worker"
import { probeBudget } from "@/scripts/research-voice/budget"
import { createProbeCall } from "@/scripts/research-voice/provider"
import { WorkerEvidence } from "@/scripts/research-voice/evidence"

function harness() {
  const record = vi.fn()
  const parser = new ProbeProtocol("probe-1", record)
  const event = (value: Record<string, unknown>) => parser.accept(JSON.stringify(value))
  const session = () => ({ ...probePolicy("probe-1"), id: "session-1" })
  const configure = () => { event({ type: "session.created", session: session() }); event({ type: "session.updated", session: session() }); parser.requestGreeting() }
  const greeting = (previous: string | null | undefined = null) => {
    event({ type: "conversation.item.added", event_id: "event-1", previous_item_id: previous, item: { id: "assistant-1", type: "message", role: "assistant", content: [] } })
    event({ type: "response.output_item.added", event_id: "event-2", response_id: "response-1", item: { id: "assistant-1", type: "message", role: "assistant", content: [] } })
    event({ type: "response.done", event_id: "event-3", response: { id: "response-1", status: "completed", output: [{ id: "assistant-1", type: "message", role: "assistant", content: [{ type: "output_audio", transcript: "Say hello Compass." }] }] } })
  }
  return { parser, record, event, session, configure, greeting }
}

describe("worker evidence failure dominance", () => {
  it("ignores queued provider events and late open after the socket has failed", async () => {
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const { parser, record } = harness()
    const accept = vi.spyOn(parser, "accept")
    const promise = observeProbeSocket(socket as unknown as Parameters<typeof observeProbeSocket>[0], parser, "probe-1", Date.now() + 1000, record)
    socket.dispatchEvent(new Event("error"))
    socket.dispatchEvent(new MessageEvent("message", { data: "malformed" }))
    socket.dispatchEvent(new Event("open"))
    await expect(promise).rejects.toThrow("SIDEBAND_TRANSPORT_FAILED")
    expect(accept).not.toHaveBeenCalled()
    expect(socket.send).not.toHaveBeenCalled()
  })
  it("classifies an open handler send exception without leaking the provider error", async () => {
    const socket = Object.assign(new EventTarget(), { send: vi.fn(() => { throw new Error("private transport detail") }), close: vi.fn() })
    const { parser, record } = harness()
    const promise = observeProbeSocket(socket as unknown as Parameters<typeof observeProbeSocket>[0], parser, "probe-1", Date.now() + 1000, record)
    socket.dispatchEvent(new Event("open"))
    await expect(promise).rejects.toThrow("PROBE_OPERATION_FAILED")
  })
  it.each(["premedia", "complete"])("rejects %s followed by failure in the same log chunk", (kind) => {
    const evidence = new WorkerEvidence()
    evidence.accept({ kind, status: kind === "premedia" ? "ROOT_AND_POLICY_OBSERVED" : "SYNTHETIC_EXCHANGE_OBSERVED" })
    evidence.accept({ kind: "failure", code: "PROVIDER_ITEM_CONFLICT" })
    expect(() => evidence.ready()).toThrow("PROVIDER_ITEM_CONFLICT")
    expect(() => evidence.complete()).toThrow("PROVIDER_ITEM_CONFLICT")
  })
  it("requires complete plus settled worker stop receipt for final proof", () => {
    const evidence = new WorkerEvidence()
    evidence.accept({ kind: "complete", status: "SYNTHETIC_EXCHANGE_OBSERVED" })
    expect(evidence.complete()).toBe(false)
    evidence.accept({ kind: "provider_stop", status: "STOPPED" })
    expect(evidence.complete()).toBe(true)
    expect(evidence.providerStopped()).toBe(true)
  })
})

describe("controlled voice probe protocol", () => {
  it("reports numeric creation status without retaining an error body and uses string multipart fields", async () => {
    const onStatus = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider body", { status: 400 }))
    await expect(createProbeCall({ key: "synthetic", offer: "v=0\r\nm=audio 9 RTP/AVP 0\r\n", runId: "probe-1", signal: AbortSignal.timeout(1000), onId: vi.fn(), onStatus, fetcher })).rejects.toThrow("PROVIDER_CREATE_UNRESOLVED")
    expect(onStatus).toHaveBeenCalledWith(400)
    const form = fetcher.mock.calls[0][1]!.body as FormData
    expect(typeof form.get("sdp")).toBe("string")
    expect(form.get("session")).toBe(JSON.stringify(probePolicy("probe-1")))
  })
  it("journals the trusted provider identity before attempting to read a failed SDP body", async () => {
    const onId = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("body failed")) } }), {
      status: 201, headers: { location: "/v1/realtime/calls/rtc-synthetic" },
    }))
    await expect(createProbeCall({ key: "synthetic", offer: "v=0\r\nm=audio 9 RTP/AVP 0\r\n", runId: "probe-1", signal: AbortSignal.timeout(1000), onId, fetcher })).rejects.toThrow()
    expect(onId).toHaveBeenCalledWith("rtc-synthetic")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({ redirect: "error" }))
  })
  it("requires a conservative sub-$5 budget including transcription and Sandbox reserve", () => {
    const budget = probeBudget()
    expect(budget.estimatedUsd).toBeGreaterThan(1)
    expect(budget.estimatedUsd).toBeLessThan(5)
    expect(budget).toMatchObject({ audioInputTokens: 1200, maxOutputTokens: 128, transcriptionReserveUsd: 0.05, sandboxReserveUsd: 0.25 })
    expect(() => probeBudget(121)).toThrow("INVALID_BUDGET_DURATION")
  })
  it("worker fallback cleanup is bounded and never accepts arbitrary provider 404", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValue(new Response(null, { status: 404 }))
    expect(await stopWorkerProvider("call-1", "synthetic", fetcher)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls/call-1/hangup", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal), redirect: "error" }))
    expect(await stopWorkerProvider("call-1", "synthetic", fetcher)).toBe(false)
  })
  it("rejects non-Vercel targets and forbids redirects on actual allocation dispatch", async () => {
    const raw = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"))
    const guarded = singleDispatchFetch(raw)
    await expect(guarded("https://attacker.example/api/v2/sandboxes", { method: "POST" })).rejects.toThrow("UNEXPECTED_SANDBOX_TARGET")
    await guarded("https://vercel.com/api/v2/sandboxes", { method: "POST" })
    expect(raw).toHaveBeenCalledWith("https://vercel.com/api/v2/sandboxes", expect.objectContaining({ redirect: "error" }))
  })
  function adapters(): ProbeAdapters {
    return { record: vi.fn(), createProvider: vi.fn(async () => {}), createSandbox: vi.fn(async () => {}), startWorker: vi.fn(async () => {}),
      waitReady: vi.fn(async () => {}), releaseBrowser: vi.fn(async () => {}), waitComplete: vi.fn(async () => {}),
      stopProvider: vi.fn(async () => true), stopSandbox: vi.fn(async () => true), closeBrowser: vi.fn(async () => {}) }
  }
  it("cleans both resources independently on pre-media startup failure without releasing SDP", async () => {
    const io = adapters()
    vi.mocked(io.waitReady).mockRejectedValue(new Error("PREMEDIA_NOT_DEMONSTRATED"))
    vi.mocked(io.stopProvider).mockRejectedValue(new Error("provider stop uncertain"))
    const result = await executeProbe(io)
    expect(result).toMatchObject({ outcome: "PREMEDIA_NOT_DEMONSTRATED", providerStopped: false, sandboxStopped: true })
    expect(io.releaseBrowser).not.toHaveBeenCalled()
    expect(io.stopSandbox).toHaveBeenCalledOnce()
    expect(io.createProvider).toHaveBeenCalledOnce()
  })
  it("reserves cleanup time when startup exhausts its absolute deadline", async () => {
    const io = adapters()
    vi.mocked(io.waitReady).mockImplementation((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("PREMEDIA_NOT_DEMONSTRATED")), { once: true })))
    await executeProbe(io, 80)
    expect(io.releaseBrowser).not.toHaveBeenCalled()
    expect(io.stopProvider).toHaveBeenCalledOnce()
    expect(io.stopSandbox).toHaveBeenCalledOnce()
  })
  it("cleans a late allocation result without advancing worker or browser phases", async () => {
    const io = adapters()
    let known = false
    vi.mocked(io.createProvider).mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 85)); known = true })
    vi.mocked(io.stopProvider).mockImplementation(async () => known)
    const result = await executeProbe(io, 100)
    expect(result.providerStopped).toBe(true)
    expect(io.startWorker).not.toHaveBeenCalled()
    expect(io.releaseBrowser).not.toHaveBeenCalled()
  })
  it("does not report success when closing the synthetic browser fails", async () => {
    const io = adapters()
    vi.mocked(io.closeBrowser).mockRejectedValue(new Error("browser stuck"))
    expect(await executeProbe(io)).toMatchObject({ browserStopped: false })
  })
  it("persists an exclusive one-attempt claim that remains consumed after failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-probe-journal-"))
    try {
      const path = join(dir, "attempt.jsonl")
      const first = new ProbeJournal(path)
      first.record({ kind: "phase", phase: "STARTING" }); first.close()
      expect(readFileSync(path, "utf8")).toContain("STARTING")
      expect(() => new ProbeJournal(path)).toThrow()
    } finally { rmSync(dir, { recursive: true }) }
  })
  it("rejects unknown journal fields instead of accidentally recording secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-probe-journal-"))
    const journal = new ProbeJournal(join(dir, "attempt.jsonl"))
    try { expect(() => journal.record({ kind: "phase", sdp: "private" })).toThrow("UNSAFE_JOURNAL_FIELD") }
    finally { journal.close(); rmSync(dir, { recursive: true }) }
  })
  it("blocks actual SDK command retries on the original Session without resuming", async () => {
    const now = Date.now()
    const metadata = { sandbox: { name: "synthetic", persistent: false, createdAt: now, updatedAt: now, currentSessionId: "s-1", status: "running" },
      session: { id: "s-1", memory: 2048, vcpus: 1, region: "iad1", runtime: "node22", timeout: 120000, status: "running", requestedAt: now, createdAt: now, updatedAt: now, cwd: "/vercel/sandbox" }, routes: [] }
    const raw = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValue(new Response("failed", { status: 500 }))
    const sandbox = await Sandbox.get({ token: "synthetic", teamId: "team-synthetic", projectId: "prj-synthetic", name: "synthetic", resume: false, fetch: singleDispatchFetch(raw) })
    await expect(sandbox.currentSession().runCommand({ cmd: "node", args: [], detached: true })).rejects.toThrow()
    expect(raw).toHaveBeenCalledTimes(2) // lookup + one actual command POST
    expect(raw.mock.calls.some(([url]) => String(url).includes("resume=true"))).toBe(false)
  })
  it("blocks actual Sandbox SDK allocation retry dispatch after a network failure", async () => {
    const raw = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic network failure"))
    await expect(Sandbox.create({
      token: "synthetic-token", teamId: "team-synthetic", projectId: "prj-synthetic",
      name: "probe-synthetic", persistent: false, runtime: "node22", fetch: singleDispatchFetch(raw),
    })).rejects.toThrow()
    expect(raw).toHaveBeenCalledTimes(1)
  })
  it("requires matching policy and a real completed canonical root before releasing SDP", () => {
    const { parser, configure, greeting } = harness()
    expect(parser.ready()).toBe(false)
    configure()
    expect(parser.ready()).toBe(false)
    greeting()
    expect(parser.ready()).toBe(true)
    expect(parser.complete()).toBe(false)
  })
  it("does not invent a root when predecessor evidence is missing", () => {
    const { parser, configure, greeting } = harness()
    configure(); greeting("missing-root")
    expect(parser.ready()).toBe(false)
  })
  it("does not coerce an omitted predecessor into an explicit root", () => {
    const { parser, configure, event } = harness()
    configure()
    event({ type: "conversation.item.added", event_id: "event-no-root", item: { id: "assistant-1", type: "message", role: "assistant", content: [] } })
    event({ type: "response.done", event_id: "done-no-root", response: { id: "response-1", status: "completed", output: [{ id: "assistant-1", type: "message", role: "assistant", content: [{ type: "output_audio", transcript: "Hello." }] }] } })
    expect(parser.ready()).toBe(false)
  })
  it("rejects a policy mismatch before any response is requested", () => {
    const { event, session } = harness()
    expect(() => event({ type: "session.created", session: { ...session(), max_output_tokens: 4096 } })).toThrow("POLICY_MISMATCH")
  })
  it("correlates updated policy to the actual created session and probe nonce", () => {
    const { event, session } = harness()
    event({ type: "session.created", session: session() })
    expect(() => event({ type: "session.updated", session: { ...session(), id: "different-session" } })).toThrow("POLICY_MISMATCH")
  })
  it("rejects malformed provider input without logging its body", () => {
    const { parser, record } = harness()
    expect(() => parser.accept("secret invalid JSON")).toThrow("INVALID_PROVIDER_EVENT")
    expect(record).not.toHaveBeenCalled()
  })
  it("records only redacted linked canonical evidence for the synthetic exchange", () => {
    const { parser, configure, greeting, event, record } = harness()
    configure(); greeting()
    event({ type: "input_audio_buffer.committed", event_id: "event-4", item_id: "user-1", previous_item_id: "assistant-1" })
    event({ type: "conversation.item.input_audio_transcription.completed", event_id: "event-5", item_id: "user-1", content_index: 0, transcript: "Hello Compass synthetic sample." })
    expect(parser.complete()).toBe(true)
    const serialized = JSON.stringify(record.mock.calls)
    expect(serialized).not.toContain("Hello Compass")
    expect(serialized).not.toContain("Say hello")
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: "canonical", role: "PARTICIPANT", ordinal: 1 }))
  })
  it("never requests a second response", () => {
    const { parser, configure } = harness()
    configure()
    expect(() => parser.requestGreeting()).toThrow("RESPONSE_ALREADY_REQUESTED")
  })
})
