// Run-callback reporter shared by the sandbox entry scripts (turn-entry.ts for the
// Claude harness, opencode-turn-entry.ts for the experimental opencode harness).
// Batches events back to Compass with a monotonic `seq`, heartbeats, and delivers
// the terminal event. Written into the sandbox next to the entry script by
// app/api/agent/turn/route.ts, so it must stay strip-only TypeScript (see the
// guard in __tests__/agent-entry-scripts.test.ts).

export type RunEventType = "status" | "agent" | "result" | "error" | "heartbeat"
type OutboundEvent = { seq: number; type: RunEventType; payload: unknown }

/** Server caps a batch at 32 events / 256 KiB; stay comfortably inside both. */
const FLUSH_EVENT_COUNT = 32
const FLUSH_INTERVAL_MS = 500
const MAX_BATCH_BYTES = 200 * 1024
/**
 * A single event larger than this is replaced by a marker rather than dropped or
 * allowed to blow the batch cap. Generalizes the old 1 MB stdout transport guard:
 * one pathological tool result should cost its own payload, not the transcript.
 */
const MAX_EVENT_BYTES = 64 * 1024
/** Bound on unsent events when Compass is unreachable. Beyond this the oldest go. */
const MAX_BACKLOG = 256
export const DEFAULT_HEARTBEAT_MS = 15_000

export class RunReporter {
  private queue: OutboundEvent[] = []
  private nextSeq = 1
  private flushing: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private dropped = 0
  /** Set when the server reports this run already terminal — the agent should stop. */
  canceledStatus: string | undefined

  private readonly eventsUrl: string
  private readonly heartbeatUrl: string
  private readonly headers: Record<string, string>
  private readonly heartbeatMs: number
  private readonly note: (message: string) => void

  // Fields are declared and assigned explicitly rather than via TypeScript
  // parameter properties (`constructor(private readonly x: string)`). This file is
  // executed as `node entry.ts` inside the sandbox, where Node only *erases*
  // types; parameter properties need real codegen, so they abort the process at
  // load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before a single heartbeat goes
  // out. Keep every construct in this file strip-only safe — see the guard in
  // __tests__/agent-entry-scripts.test.ts.
  constructor(
    eventsUrl: string,
    heartbeatUrl: string,
    headers: Record<string, string>,
    heartbeatMs: number,
    note: (message: string) => void,
  ) {
    this.eventsUrl = eventsUrl
    this.heartbeatUrl = heartbeatUrl
    this.headers = headers
    this.heartbeatMs = heartbeatMs
    this.note = note
  }

  start() {
    this.heartbeat = setInterval(() => { void this.sendHeartbeat() }, this.heartbeatMs)
    // The interval must never be the reason the process stays alive.
    this.heartbeat.unref?.()
  }

  enqueue(type: RunEventType, payload: unknown) {
    let serialized = payload
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8")
    if (bytes > MAX_EVENT_BYTES) serialized = { truncated: true, type, bytes }
    this.queue.push({ seq: this.nextSeq++, type, payload: serialized })
    if (this.queue.length > MAX_BACKLOG) {
      // Drop from the head: the tail is what a watching user is reading, and a
      // backlog this deep means Compass has been unreachable for a while.
      this.dropped += this.queue.length - MAX_BACKLOG
      this.queue = this.queue.slice(this.queue.length - MAX_BACKLOG)
    }
    if (this.queue.length >= FLUSH_EVENT_COUNT) {
      void this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush() }, FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /** Serialized so two flushes cannot interleave and reorder sequences. */
  flush(attempts = 2): Promise<void> {
    this.flushing = this.flushing.then(() => this.drain(attempts)).catch(() => {})
    return this.flushing
  }

  private takeBatch(): OutboundEvent[] {
    const batch: OutboundEvent[] = []
    let bytes = 0
    while (this.queue.length > 0 && batch.length < FLUSH_EVENT_COUNT) {
      const next = this.queue[0]!
      const size = Buffer.byteLength(JSON.stringify(next), "utf8")
      if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break
      batch.push(next)
      bytes += size
      this.queue.shift()
    }
    return batch
  }

  private async drain(attempts: number) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.queue.length > 0) {
      const batch = this.takeBatch()
      if (batch.length === 0) break
      const delivered = await this.post(this.eventsUrl, { events: batch }, attempts)
      if (!delivered) {
        // Put them back at the head so ordering survives a transient failure.
        this.queue = [...batch, ...this.queue]
        return
      }
    }
    if (this.dropped > 0) {
      this.note(`dropped ${this.dropped} event(s) after the backlog cap was reached`)
      this.dropped = 0
    }
  }

  private async post(url: string, body: unknown, attempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (response.ok) {
          const data = await response.json().catch(() => null) as { status?: string } | null
          // 4xx other than 409 means retrying cannot help: a revoked token, a
          // finished run, or a batch the server will never accept.
          if (data?.status && data.status !== "QUEUED" && data.status !== "RUNNING") {
            this.canceledStatus = data.status
          }
          return true
        }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          this.canceledStatus = `HTTP_${response.status}`
          this.note(`callback rejected with ${response.status}; giving up on this channel`)
          return false
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) {
          this.note(`callback refused with ${response.status}; dropping batch`)
          return true
        }
        this.note(`callback attempt ${attempt} failed with ${response.status}`)
      } catch (error) {
        this.note(`callback attempt ${attempt} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
    return false
  }

  private async sendHeartbeat() {
    try {
      const response = await fetch(this.heartbeatUrl, { method: "POST", headers: this.headers })
      if (!response.ok) {
        if (response.status === 401 || response.status === 404) this.canceledStatus = `HTTP_${response.status}`
        return
      }
      const data = await response.json().catch(() => null) as { status?: string } | null
      if (data?.status && data.status !== "QUEUED" && data.status !== "RUNNING") this.canceledStatus = data.status
    } catch {
      // A missed heartbeat is not itself fatal; the sweeper's margin covers
      // several of them, and event batches also refresh the heartbeat.
    }
  }

  /**
   * Deliver the terminal event and stop.
   *
   * Retried harder than an ordinary batch: losing this one means the run sits
   * `RUNNING` until the sweeper marks it `INTERRUPTED`, which is a materially
   * worse outcome for the user than a missing intermediate event.
   */
  async finish(type: "result" | "error", payload: unknown) {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.canceledStatus) {
      this.note(`run already terminal (${this.canceledStatus}); not reporting ${type}`)
      return
    }
    this.enqueue(type, payload)
    await this.flush(5)
  }
}

