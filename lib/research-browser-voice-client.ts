export class VoiceSaveQueue<T> {
  private pending: T[] = []
  private running: Promise<void> | null = null
  private failure: unknown = null
  constructor(private save: (value: T) => Promise<void>) {}
  append(value: T) { this.pending.push(value); return this.flush() }
  async flush(): Promise<void> {
    if (this.failure) throw this.failure
    if (!this.running && this.pending.length) {
      this.running = (async () => {
        try {
          while (this.pending.length) {
            await this.save(this.pending[0])
            this.pending.shift()
          }
        } catch (error) { this.failure = error; throw error }
      })()
    }
    const current = this.running
    try { await current } finally { if (this.running === current) this.running = null }
    if (this.failure) throw this.failure
    if (this.pending.length) await this.flush()
  }
  async retry() { this.failure = null; await this.flush() }
}

export type VoiceCaption = { id: string; role: "PARTICIPANT" | "INTERVIEWER"; content: string; partial: boolean }

export type ReportedVoiceFinal = { providerEventId: string; role: "PARTICIPANT" | "INTERVIEWER"; content: string; attachmentId?: string }
export class VoiceFinalOrder {
  private order: string[] = []
  private entries = new Map<string, { final?: ReportedVoiceFinal; promise?: Promise<void>; resolve?: () => void; reject?: (error: unknown) => void }>()
  private next = 0
  constructor(private persist: (event: ReportedVoiceFinal) => Promise<void>) {}
  private register(id: string) {
    if (!this.entries.has(id)) {
      if (this.order.length >= 200) throw new Error("Voice event buffer limit reached")
      this.order.push(id); this.entries.set(id, {})
    }
    return this.entries.get(id)!
  }
  observe(event: Record<string, unknown>) {
    if (event.type !== "conversation.item.added" && event.type !== "conversation.item.created" && event.type !== "response.output_item.added") return
    const item = event.item as { id?: unknown; role?: unknown; content?: Array<{ type?: string }> } | undefined
    if (typeof item?.id !== "string") return
    // Pacing/text-only items are not pending speech. Assistant audio item content
    // is commonly empty when first announced, before its transcript deltas.
    if (item.role === "assistant") this.register(`output:${item.id}`)
    else if (item.role === "user" && item.content?.some((part) => part.type === "input_audio" || part.type === "audio")) this.register(`input:${item.id}`)
  }
  finalize(event: ReportedVoiceFinal) {
    const entry = this.register(event.providerEventId)
    if (entry.promise) return entry.promise
    entry.final = event
    entry.promise = new Promise<void>((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    while (this.next < this.order.length) {
      const ready = this.entries.get(this.order[this.next])!
      if (!ready.final) break
      this.next += 1
      void (ready.final.content.trim() ? this.persist(ready.final) : Promise.resolve()).then(() => ready.resolve?.(), (error) => ready.reject?.(error))
    }
    return entry.promise
  }
  get unresolved() { return this.next < this.order.length }
}
export function reduceVoiceCaption(state: VoiceCaption[], event: Record<string, unknown>): VoiceCaption[] {
  const type = typeof event.type === "string" ? event.type : ""
  const input = type.startsWith("conversation.item.input_audio_transcription.")
  const output = type.startsWith("response.output_audio_transcript.")
  if ((!input && !output) || typeof event.item_id !== "string") return state
  const final = type.endsWith(".completed") || type.endsWith(".done")
  const text = final ? event.transcript : event.delta
  if (typeof text !== "string") return state
  const id = `${input ? "input" : "output"}:${event.item_id}`
  const prior = state.find((caption) => caption.id === id)
  if (prior && !prior.partial) return state
  const next: VoiceCaption = { id, role: input ? "PARTICIPANT" : "INTERVIEWER", content: final ? text.trim() : (prior?.content ?? "") + text, partial: !final }
  if (next.content.length + state.reduce((size, caption) => size + (caption.id === id ? 0 : caption.content.length), 0) > 80_000) throw new Error("Voice caption limit reached")
  return prior ? state.map((caption) => caption.id === id ? next : caption) : [...state, next]
}
