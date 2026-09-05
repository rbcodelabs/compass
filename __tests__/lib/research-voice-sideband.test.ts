import { describe, expect, it } from "vitest"
import { ResearchVoiceSidebandBuffer } from "@/lib/research-voice-sideband"

const added = (id: string, previous: string | null, role = "user") => ({
  type: "conversation.item.added", event_id: `added-${id}`, previous_item_id: previous,
  item: { id, type: "message", role, content: [{ type: role === "user" ? "input_audio" : "output_audio" }] },
})
const transcribed = (id: string, transcript = "participant words") => ({
  type: "conversation.item.input_audio_transcription.completed", event_id: `final-${id}`, item_id: id, content_index: 0, transcript,
})
const response = (id: string, status = "completed", transcript = "interviewer words") => ({
  type: "response.done", event_id: `response-${id}`, response: {
    id: `resp-${id}`, status, output: [{ id, type: "message", role: "assistant", content: [{ type: "output_audio", transcript }] }],
  },
})
const buffer = () => new ResearchVoiceSidebandBuffer({ voiceCallId: "call-1", sessionId: "session-1" })

describe("versioned Realtime sideband parser", () => {
  it("orders by provider predecessors and waits for participant finalization before later responses", () => {
    const b = buffer()
    b.accept(added("u", null)); b.accept(added("a", "u", "assistant")); b.accept(response("a"))
    expect(b.peekBatch()).toBeNull()
    b.accept(transcribed("u"))
    const batch = b.peekBatch()!
    expect(batch.version).toBe(1)
    expect(batch.events.map((e) => [e.providerOrdinal, e.role, e.providerItemId])).toEqual([[0, "PARTICIPANT", "u"], [1, "INTERVIEWER", "a"]])
    expect(b.peekBatch()).toEqual(batch)
    b.acknowledge(batch.batchId, 2)
    expect(b.peekBatch()).toBeNull()
    expect(b.cursor()).toEqual({ nextProviderOrdinal: 2, lastProviderItemId: "a" })
  })

  it("correlates out-of-order response completion and transcription to actual item roles", () => {
    const b = buffer()
    b.accept(response("a")); b.accept(transcribed("u")); b.accept(added("a", "u", "assistant")); b.accept(added("u", null))
    expect(b.peekBatch()!.events.map((e) => e.content)).toEqual(["participant words", "interviewer words"])
  })

  it.each(["cancelled", "failed", "incomplete"])("keeps %s interviewer provenance without canonical text", (status) => {
    const b = buffer(); b.accept(added("a", null, "assistant")); b.accept(response("a", status))
    expect(b.peekBatch()!.events[0]).toMatchObject({ providerStatus: status.toUpperCase(), content: "", role: "INTERVIEWER" })
  })

  it("treats exact event replay as a no-op and poisons conflicting event or item replay", () => {
    const b = buffer(); b.accept(added("u", null)); b.accept(transcribed("u")); b.accept(transcribed("u"))
    const batch = b.peekBatch()!; b.acknowledge(batch.batchId, 1)
    b.accept(transcribed("u"))
    expect(() => b.accept(transcribed("u", "changed"))).toThrow(/PROVIDER_(EVENT|ITEM)_CONFLICT/)
    expect(() => b.peekBatch()).toThrow(/PROVIDER_(EVENT|ITEM)_CONFLICT/)
    const c = buffer(); c.accept(added("u", null))
    expect(() => c.accept({ ...added("u", "other"), event_id: "different-event" })).toThrow("PROVIDER_ITEM_CONFLICT")
  })

  it("fails closed on failed transcription, unresolved gaps, role spoofing and unexpected tools", () => {
    const b = buffer()
    expect(() => b.accept({ type: "conversation.item.input_audio_transcription.failed", event_id: "f", item_id: "u", content_index: 0, error: {} })).toThrow("PARTICIPANT_TRANSCRIPTION_FAILED")
    const gap = buffer(); gap.accept(added("u", "missing")); gap.accept(transcribed("u"))
    expect(gap.peekBatch()).toBeNull(); expect(() => gap.assertDrained()).toThrow("PROVIDER_ORDER_GAP")
    const role = buffer(); role.accept(added("a", null, "assistant"))
    expect(() => role.accept(transcribed("a"))).toThrow("PROVIDER_ROLE_CONFLICT")
    expect(() => buffer().accept({ ...added("tool", null), item: { id: "tool", type: "function_call" } })).toThrow("UNSUPPORTED_PROVIDER_ITEM")
    expect(() => buffer().accept({ type: "response.function_call_arguments.delta", event_id: "tool", delta: "{}" })).toThrow("UNEXPECTED_PROVIDER_TOOL")
  })

  it("does not retain audio deltas and bounds unacknowledged batches and held memory", () => {
    const b = buffer()
    for (let i = 0; i < 2000; i++) b.accept({ type: "response.output_audio.delta", delta: "A".repeat(100_000) })
    for (let i = 0; i < 11; i++) { b.accept(added(`u${i}`, i ? `u${i-1}` : null)); b.accept(transcribed(`u${i}`)) }
    const batch = b.peekBatch()!
    expect(batch.events).toHaveLength(10)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(65536)
    expect(() => b.acknowledge(batch.batchId, 9)).toThrow("INVALID_BATCH_ACK")
    const overflow = buffer()
    expect(() => { for (let i = 0; i < 129; i++) overflow.accept(added(`u${i}`, i ? `u${i-1}` : "gap")) }).toThrow("PROVIDER_BUFFER_OVERFLOW")
  })

  it("rejects contradictory response or final-transcript correlation", () => {
    const b = buffer(); b.accept(added("a", null, "assistant"))
    b.accept({ type: "response.output_audio_transcript.done", event_id: "audio-final", item_id: "a", response_id: "wrong", content_index: 0, transcript: "words" })
    expect(() => b.accept(response("a"))).toThrow("PROVIDER_RESPONSE_CONFLICT")
    const c = buffer(); c.accept(added("a", null, "assistant")); c.accept(response("a"))
    expect(() => c.accept({ type: "response.output_audio_transcript.done", event_id: "audio-final", item_id: "a", response_id: "resp-a", content_index: 0, transcript: "contradiction" })).toThrow("PROVIDER_TRANSCRIPT_CONFLICT")
  })

  it("allows empty assistant content during creation but bounds final provider payloads", () => {
    const b = buffer(), initial = added("a", null, "assistant")
    initial.item.content = []
    b.accept(initial); expect(b.peekBatch()).toBeNull()
    b.accept(response("a")); expect(b.peekBatch()!.events[0].content).toBe("interviewer words")
    expect(() => buffer().accept(response("a", "completed", "x".repeat(60001)))).toThrow("PROVIDER_BUFFER_OVERFLOW")
    const huge = response("a"); huge.response.output = Array.from({ length: 129 }, () => huge.response.output[0])
    expect(() => buffer().accept(huge)).toThrow("PROVIDER_BUFFER_OVERFLOW")
  })

  it.each([true, false])("preserves an omitted done-event predecessor when done comes first=%s", (doneFirst) => {
    const b = buffer(); b.accept(added("u", null)); b.accept(transcribed("u"))
    const done = { type: "conversation.item.done", event_id: "done-a", item: added("a", "u", "assistant").item }
    if (doneFirst) b.accept(done)
    b.accept(added("a", "u", "assistant"))
    if (!doneFirst) b.accept(done)
    b.accept(response("a"))
    expect(b.peekBatch()!.events[1].providerPreviousItemId).toBe("u")
  })

  it("keeps omitted committed/added predecessors unknown and distinguishes their replay fingerprints from null", () => {
    const b = buffer()
    b.accept({ type: "input_audio_buffer.committed", event_id: "committed-u", item_id: "u" })
    b.accept(transcribed("u")); expect(b.peekBatch()).toBeNull()
    b.accept(added("u", null)); expect(b.peekBatch()!.events[0].providerPreviousItemId).toBeNull()
    const c = buffer(), omitted: Record<string, unknown> = added("u", null)
    delete omitted.previous_item_id
    c.accept(omitted); c.accept(transcribed("u")); expect(c.peekBatch()).toBeNull()
    expect(() => c.accept(added("u", null))).toThrow("PROVIDER_EVENT_CONFLICT")
  })
})
