import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ auth: vi.fn(), heartbeat: vi.fn(), append: vi.fn(), claim: vi.fn(), result: vi.fn() }))
vi.mock("@/lib/research-voice-operations", () => ({ authorizeResearchVoiceWorker: mocks.auth, recordResearchVoiceHeartbeat: mocks.heartbeat, claimResearchVoiceCommand: mocks.claim, completeResearchVoiceCommand: mocks.result }))
vi.mock("@/lib/research-voice-control-plane", async (original) => ({ ...await original<object>(), appendCanonicalVoiceBatch: mocks.append }))
import { handleResearchVoiceCallback } from "@/lib/research-voice-callback"
const callId = "00000000-0000-4000-8000-000000000001", token = "a".repeat(43)
const request = (body: unknown, authorization = `Bearer ${token}`) => new Request(`https://compass.example/api/internal/research/voice/${callId}/heartbeat`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) })
const handle = (req: Request, action: "heartbeat" | "events" | "claim" | "result" = "heartbeat") => handleResearchVoiceCallback(req, callId, action, {} as never)
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1"); mocks.auth.mockResolvedValue({ id: callId, sessionId: "session-1" }); mocks.heartbeat.mockResolvedValue({ accepted: true }); mocks.claim.mockResolvedValue(null); mocks.result.mockResolvedValue({ status: "APPLIED" }) })
afterEach(() => vi.unstubAllEnvs())

describe("internal research voice callback boundary", () => {
  it("stops disabled callbacks before any credential lookup", async () => {
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "0")
    expect((await handle(request({}))).status).toBe(404)
    expect(mocks.auth).not.toHaveBeenCalled()
  })
  it("rejects missing bearer before reading the body or querying auth", async () => {
    const req = request({}, ""); const reader = vi.spyOn(req.body!, "getReader")
    expect((await handle(req)).status).toBe(401)
    expect(reader).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled()
  })
  it("authenticates before reading streamed content and returns no-store errors", async () => {
    const req = request({}); const reader = vi.spyOn(req.body!, "getReader")
    mocks.auth.mockRejectedValue(new Error("secret database detail"))
    const res = await handle(req)
    expect(res.status).toBe(500); expect(res.headers.get("cache-control")).toBe("no-store")
    expect(reader).not.toHaveBeenCalled(); expect(await res.text()).not.toContain("secret database")
  })
  it("accepts only heartbeat RUNNING and never advances readiness", async () => {
    expect((await handle(request({ state: "READY" }))).status).toBe(400)
    expect((await handle(request({ state: "RUNNING" }))).status).toBe(200)
    expect(mocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ callId, rawToken: token }))
  })
  it("cancels a chunked body as soon as its byte cap is exceeded", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel })
    const req = new Request(`https://compass.example/${callId}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, duplex: "half" } as RequestInit)
    expect((await handle(req)).status).toBe(413); expect(cancel).toHaveBeenCalledOnce()
  })
  it("rejects query credentials, unknown keys and malformed command results", async () => {
    const req = new Request(request({}), { })
    expect((await handle(new Request(`${req.url}?token=secret`, { method: "POST", headers: req.headers, body: "{}" }))).status).toBe(400)
    expect((await handle(request({ state: "RUNNING", role: "INTERVIEWER" }))).status).toBe(400)
    expect((await handle(request({ commandId: callId, claimEpoch: 0, outcome: "APPLIED" }), "result")).status).toBe(400)
    expect((await handle(request({}), "claim")).status).toBe(200)
  })
  it("binds event callbacks to the authorized session and returns only the durable acknowledgement", async () => {
    const events = [{ voiceCallId: callId, sessionId: "session-1", providerEventId: "added-u", providerItemId: "u", providerPreviousItemId: null, providerOrdinal: 0, providerResponseId: null, providerStatus: "COMPLETED", role: "PARTICIPANT", content: "hello" }]
    mocks.append.mockResolvedValue({ nextExpectedOrdinal: 1, transcriptIntegrity: "PENDING", turns: [{ content: "private" }], abortReason: null })
    const res = await handle(request({ version: 1, batchId: "b".repeat(64), events }), "events")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ batchId: "b".repeat(64), nextProviderOrdinal: 1, transcriptIntegrity: "PENDING", abortReason: null })
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ workerToken: token, sessionId: "session-1", voiceCallId: callId, events }))
    expect((await handle(request({ version: 1, batchId: "b".repeat(64), events: [{ ...events[0], sessionId: "other" }] }), "events")).status).toBe(409)
    mocks.append.mockResolvedValue({ nextExpectedOrdinal: 0, transcriptIntegrity: "DEGRADED", abortReason: "PROVIDER_ORDER_BROKEN" })
    const rejected = await handle(request({ version: 1, batchId: "b".repeat(64), events }), "events")
    expect(rejected.status).toBe(409); expect(await rejected.json()).not.toHaveProperty("batchId")
  })
})
