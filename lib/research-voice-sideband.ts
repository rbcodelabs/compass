import { createHash } from "node:crypto"
import type { appendCanonicalVoiceBatch } from "@/lib/research-voice-control-plane"

type Event = Parameters<typeof appendCanonicalVoiceBatch>[0]["events"][number]
type Item = { id: string; previous?: string | null; role?: Event["role"]; eventId?: string; responseId?: string; audioTranscript?: string; final?: { responseId: string | null; status: string; content: string }; acknowledged?: boolean }
type Batch = { version: 1; batchId: string; events: Event[] }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROVIDER_EVENT")
  return value as Record<string, unknown>
}
const id = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 255) throw new Error("INVALID_PROVIDER_ID")
  return value
}
const ignored = new Set([
  "response.output_audio.delta", "response.output_audio.done", "response.output_audio_transcript.delta",
  "conversation.item.input_audio_transcription.delta", "conversation.item.input_audio_transcription.segment",
  "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "rate_limits.updated",
  "response.created", "response.content_part.added", "response.content_part.done", "response.output_item.done",
  "output_audio_buffer.started", "output_audio_buffer.stopped", "output_audio_buffer.cleared",
])

/** Protocol v1: audio-only default conversation. Unsupported context/tool items fail closed.
 * Event shapes verified against OpenAI's realtime.ts and Realtime guides on 2026-09-05.
 * The transport must pass only frames received from the authenticated provider socket.
 */
export class ResearchVoiceSidebandBuffer {
  private items = new Map<string, Item>()
  private seen = new Map<string, string>()
  private nextOrdinal: number
  private previous: string | null
  private pending: Batch | null = null
  private failure: string | null = null
  constructor(private binding: { voiceCallId: string; sessionId: string; nextProviderOrdinal?: number; lastProviderItemId?: string | null }) {
    this.nextOrdinal = binding.nextProviderOrdinal ?? 0
    this.previous = binding.lastProviderItemId ?? null
  }
  private fail(code: string): never { this.failure = code; throw new Error(code) }
  private healthy() { if (this.failure) throw new Error(this.failure) }
  private item(itemId: string) {
    let item = this.items.get(itemId)
    if (!item) { item = { id: itemId }; this.items.set(itemId, item) }
    return item
  }
  private role(item: Item, role: Event["role"]) {
    if (item.role && item.role !== role) this.fail("PROVIDER_ROLE_CONFLICT")
    item.role = role
  }
  private final(item: Item, final: NonNullable<Item["final"]>) {
    if (item.responseId && item.responseId !== final.responseId) this.fail("PROVIDER_RESPONSE_CONFLICT")
    if (final.status === "COMPLETED" && item.audioTranscript !== undefined && item.audioTranscript !== final.content) this.fail("PROVIDER_TRANSCRIPT_CONFLICT")
    if (item.final && digest(item.final) !== digest(final)) this.fail("PROVIDER_ITEM_CONFLICT")
    if (final.status === "COMPLETED" && !final.content.trim()) this.fail("FINAL_CONTENT_MISSING")
    item.final = final
  }
  accept(value: unknown) {
    this.healthy()
    try {
      const event = record(value)
      const type = id(event.type)
      // Drop raw audio before hashing, copying, or counting any payload.
      if (ignored.has(type)) return
      if (type.includes("function_call") || type.includes("mcp")) this.fail("UNEXPECTED_PROVIDER_TOOL")
      if (event.role !== undefined) this.fail("PROVIDER_ROLE_CONFLICT")
      if (type === "session.created" || type === "session.updated") {
        const session = record(event.session)
        if (!Array.isArray(session.tools) || session.tools.length !== 0) this.fail("UNEXPECTED_PROVIDER_TOOL")
        return
      }
      const eventId = id(event.event_id)
      let normalized: unknown
      const mutations: Array<() => void> = []
      if (type === "conversation.item.added" || type === "conversation.item.done" || type === "response.output_item.added") {
        const source = record(event.item)
        if (source.type !== "message" || !["user", "assistant"].includes(String(source.role))) this.fail("UNSUPPORTED_PROVIDER_ITEM")
        const role = source.role === "user" ? "PARTICIPANT" : "INTERVIEWER"
        if (!Array.isArray(source.content) || source.content.length > 1 || source.content.some((part) => record(part).type !== (role === "PARTICIPANT" ? "input_audio" : "output_audio"))) this.fail("UNSUPPORTED_PROVIDER_ITEM")
        const itemId = id(source.id)
        const previous = event.previous_item_id === undefined ? undefined : event.previous_item_id === null ? null : id(event.previous_item_id)
        normalized = [type, itemId, role, type === "response.output_item.added" ? id(event.response_id) : previous === undefined ? ["unknown"] : previous]
        mutations.push(() => {
        const item = this.item(itemId); this.role(item, role)
        if (type === "response.output_item.added") {
          if (role !== "INTERVIEWER") this.fail("PROVIDER_ROLE_CONFLICT")
          const responseId = id(event.response_id)
          if ((item.responseId && item.responseId !== responseId) || (item.final && item.final.responseId !== responseId)) this.fail("PROVIDER_RESPONSE_CONFLICT")
          item.responseId = responseId
        }
        if (type !== "response.output_item.added" && previous !== undefined) {
          if (item.previous !== undefined && item.previous !== previous) this.fail("PROVIDER_ITEM_CONFLICT")
          if (itemId === previous || [...this.items.values()].some((other) => other.id !== itemId && other.previous === previous)) this.fail("PROVIDER_ORDER_CONFLICT")
          item.previous = previous
          item.eventId ??= eventId
        }
        })
      } else if (type === "input_audio_buffer.committed") {
        const itemId = id(event.item_id), previous = event.previous_item_id === undefined ? undefined : event.previous_item_id === null ? null : id(event.previous_item_id)
        normalized = [type, itemId, previous === undefined ? ["unknown"] : previous]
        mutations.push(() => {
        const item = this.item(itemId); this.role(item, "PARTICIPANT")
        if (previous !== undefined) {
          if (item.previous !== undefined && item.previous !== previous) this.fail("PROVIDER_ITEM_CONFLICT")
          item.previous = previous
        }
        item.eventId ??= eventId
        })
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        const itemId = id(event.item_id)
        if (event.content_index !== 0 || typeof event.transcript !== "string") this.fail("INVALID_PROVIDER_TRANSCRIPT")
        if (Buffer.byteLength(event.transcript) > 60_000) this.fail("PROVIDER_BUFFER_OVERFLOW")
        normalized = [type, itemId, event.transcript]
        const transcript = event.transcript
        mutations.push(() => {
        const item = this.item(itemId); this.role(item, "PARTICIPANT")
        this.final(item, { responseId: null, status: "COMPLETED", content: transcript })
        })
      } else if (type === "conversation.item.input_audio_transcription.failed") {
        this.fail("PARTICIPANT_TRANSCRIPTION_FAILED")
      } else if (type === "response.done") {
        const response = record(event.response), responseId = id(response.id)
        if (!["completed", "cancelled", "failed", "incomplete"].includes(String(response.status)) || !Array.isArray(response.output)) this.fail("INVALID_PROVIDER_RESPONSE")
        if (response.output.length > 128) this.fail("PROVIDER_BUFFER_OVERFLOW")
        let responseBytes = 0
        const finals = response.output.map((value) => {
          const source = record(value)
          if (source.type !== "message" || source.role !== "assistant" || !Array.isArray(source.content) || source.content.length > 1 || source.content.some((part) => record(part).type !== "output_audio")) this.fail("UNSUPPORTED_PROVIDER_ITEM")
          const itemId = id(source.id)
          const content = response.status === "completed" ? source.content.map((part) => {
            const transcript = record(part).transcript
            if (typeof transcript !== "string") this.fail("FINAL_CONTENT_MISSING")
            responseBytes += Buffer.byteLength(transcript)
            if (responseBytes > 60_000) this.fail("PROVIDER_BUFFER_OVERFLOW")
            return transcript
          }).join("\n") : ""
          const final = { responseId, status: String(response.status).toUpperCase(), content }
          mutations.push(() => { const item = this.item(itemId); this.role(item, "INTERVIEWER"); this.final(item, final) })
          return [itemId, final]
        })
        normalized = [type, responseId, response.status, finals]
      } else if (type === "response.output_audio_transcript.done") {
        // response.done is authoritative for terminal status and full output text.
        if (event.content_index !== 0 || typeof event.transcript !== "string") this.fail("INVALID_PROVIDER_TRANSCRIPT")
        if (Buffer.byteLength(event.transcript) > 60_000) this.fail("PROVIDER_BUFFER_OVERFLOW")
        const itemId = id(event.item_id), transcript = event.transcript
        const responseId = id(event.response_id)
        mutations.push(() => {
        const item = this.item(itemId); this.role(item, "INTERVIEWER")
        if ((item.responseId && item.responseId !== responseId) || (item.final && item.final.responseId !== responseId)) this.fail("PROVIDER_RESPONSE_CONFLICT")
        if ((item.audioTranscript !== undefined && item.audioTranscript !== event.transcript) || (item.final?.status === "COMPLETED" && item.final.content !== event.transcript)) this.fail("PROVIDER_TRANSCRIPT_CONFLICT")
        item.responseId = responseId; item.audioTranscript = transcript
        })
        normalized = [type, itemId, responseId, transcript]
      } else this.fail("UNSUPPORTED_PROVIDER_EVENT")
      const hash = digest(normalized)
      if (this.seen.has(eventId) && this.seen.get(eventId) !== hash) this.fail("PROVIDER_EVENT_CONFLICT")
      if (this.seen.has(eventId)) return
      for (const mutate of mutations) mutate()
      this.seen.set(eventId, hash)
      if (this.items.size > 128 || this.seen.size > 1024 || Buffer.byteLength(JSON.stringify([...this.items.values()])) > 256 * 1024) this.fail("PROVIDER_BUFFER_OVERFLOW")
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "INVALID_PROVIDER_EVENT")
    }
  }
  peekBatch(): Batch | null {
    this.healthy()
    if (this.pending) return structuredClone(this.pending)
    const events: Event[] = []
    let previous = this.previous
    while (events.length < 10) {
      const candidates = [...this.items.values()].filter((item) => !item.acknowledged && item.previous === previous)
      if (candidates.length > 1) this.fail("PROVIDER_ORDER_CONFLICT")
      const item = candidates[0]
      if (!item?.final || !item.role || !item.eventId) break
      const event: Event = {
        voiceCallId: this.binding.voiceCallId, sessionId: this.binding.sessionId,
        providerEventId: item.eventId, providerItemId: item.id, providerPreviousItemId: previous,
        providerOrdinal: this.nextOrdinal + events.length, providerResponseId: item.final.responseId,
        providerStatus: item.final.status, role: item.role, content: item.final.content,
      }
      const next = [...events, event]
      if (Buffer.byteLength(JSON.stringify({ version: 1, batchId: "x".repeat(64), events: next })) > 64 * 1024) {
        if (!events.length) this.fail("PROVIDER_BATCH_OVERFLOW")
        break
      }
      events.push(event); previous = item.id
    }
    if (!events.length) return null
    this.pending = { version: 1, batchId: digest(events), events }
    return structuredClone(this.pending)
  }
  acknowledge(batchId: string, nextProviderOrdinal: number) {
    this.healthy()
    if (!this.pending || this.pending.batchId !== batchId || nextProviderOrdinal !== this.nextOrdinal + this.pending.events.length) throw new Error("INVALID_BATCH_ACK")
    for (const event of this.pending.events) this.items.get(event.providerItemId)!.acknowledged = true
    this.nextOrdinal = nextProviderOrdinal
    this.previous = this.pending.events.at(-1)!.providerItemId
    this.pending = null
  }
  cursor() { return { nextProviderOrdinal: this.nextOrdinal, lastProviderItemId: this.previous } }
  assertDrained() {
    this.healthy()
    if (this.pending || [...this.items.values()].some((item) => !item.acknowledged)) this.fail("PROVIDER_ORDER_GAP")
  }
}
