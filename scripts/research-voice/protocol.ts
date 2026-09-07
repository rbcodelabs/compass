import { createHash } from "node:crypto"
import { ResearchVoiceSidebandBuffer } from "../../lib/research-voice-sideband"

export function probePolicy(runId: string) {
  return {
    type: "realtime", model: "gpt-realtime-2.1", tools: [], tool_choice: "none",
    output_modalities: ["audio"], max_output_tokens: 128,
    instructions: `Synthetic feasibility probe ${runId}. Ask the listener to say hello Compass, in one short sentence. No tools.`,
    audio: { input: { transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
      turn_detection: { type: "server_vad", create_response: false, interrupt_response: false } },
    output: { voice: "marin" } },
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROVIDER_EVENT")
  return value as Record<string, unknown>
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected)
  if (expected && typeof expected === "object") return Boolean(actual && typeof actual === "object") &&
    Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value))
  return actual === expected
}

export class ProbeProtocol {
  private buffer: ResearchVoiceSidebandBuffer
  private sessionId: string | null = null
  private acknowledged = false
  private requested = false
  private root = false
  private participant = false
  private responseIds = new Set<string>()
  constructor(private runId: string, private record: (entry: Record<string, unknown>) => void) {
    this.buffer = new ResearchVoiceSidebandBuffer({ voiceCallId: runId, sessionId: runId })
  }
  accept(raw: string) {
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("PROVIDER_FRAME_OVERFLOW")
    let event: Record<string, unknown>
    try { event = object(JSON.parse(raw)) } catch { throw new Error("INVALID_PROVIDER_EVENT") }
    if (event.type === "session.created" || event.type === "session.updated") {
      const session = object(event.session)
      if (!matches(session, probePolicy(this.runId)) || typeof session.id !== "string") throw new Error("POLICY_MISMATCH")
      if (event.type === "session.created") {
        if (this.sessionId && this.sessionId !== session.id) throw new Error("POLICY_MISMATCH")
        this.sessionId = session.id
      } else {
        if (session.id !== this.sessionId) throw new Error("POLICY_MISMATCH")
        this.acknowledged = true
      }
      return
    }
    if (String(event.type).startsWith("response.")) {
      if (!this.requested) throw new Error("UNSOLICITED_RESPONSE")
      if (event.type === "response.created" || event.type === "response.done") {
        const id = object(event.response).id
        if (typeof id !== "string") throw new Error("INVALID_PROVIDER_EVENT")
        this.responseIds.add(id)
        if (this.responseIds.size > 1) throw new Error("UNSOLICITED_RESPONSE")
      }
    }
    this.buffer.accept(event)
    for (let batch = this.buffer.peekBatch(); batch; batch = this.buffer.peekBatch()) {
      for (const item of batch.events) {
        if (item.providerStatus !== "COMPLETED") throw new Error("INCOMPLETE_CANONICAL_EVENT")
        if (item.providerOrdinal === 0) {
          if (!this.acknowledged || !this.requested || item.role !== "INTERVIEWER" || item.providerPreviousItemId !== null) throw new Error("INVALID_INITIAL_ROOT")
          this.root = true
        } else if (item.providerOrdinal === 1 && item.role === "PARTICIPANT" && this.root) this.participant = true
        else throw new Error("UNEXPECTED_CANONICAL_EVENT")
        this.record({ kind: "canonical", batchId: batch.batchId, role: item.role, ordinal: item.providerOrdinal,
          itemId: item.providerItemId, previousItemId: item.providerPreviousItemId, responseId: item.providerResponseId,
          status: item.providerStatus, chars: item.content.length,
          sha256: createHash("sha256").update(item.content).digest("hex") })
      }
      this.buffer.acknowledge(batch.batchId, this.buffer.cursor().nextProviderOrdinal + batch.events.length)
    }
  }
  ready() { return this.acknowledged && this.root }
  complete() { if (!this.participant) return false; this.buffer.assertDrained(); return true }
  policyAcknowledged() { return this.acknowledged }
  requestGreeting() {
    if (this.requested) throw new Error("RESPONSE_ALREADY_REQUESTED")
    if (!this.acknowledged) throw new Error("POLICY_NOT_ACKNOWLEDGED")
    this.requested = true
    return { type: "response.create", response: { output_modalities: ["audio"], max_output_tokens: 128, tools: [], tool_choice: "none" } }
  }
}
