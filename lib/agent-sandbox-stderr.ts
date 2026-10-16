/**
 * Folding sandbox stderr into the error a turn actually reports.
 *
 * The agent turn route streams the sandbox's stdout as SSE, because stdout
 * carries the entry script's structured `AGENT_*` protocol. Stderr carried no
 * protocol, so the log loop dropped it (`if (log.stream !== "stdout") continue`).
 *
 * That made a whole class of failure illegible. When the sandbox process dies
 * for a reason the entry script never gets to report — a module that throws on
 * import, an OOM kill, a bad `node` invocation, the Agent SDK writing a
 * diagnostic to stderr and exiting — the only thing reaching the client was
 * `agent process exited with code 1`. The actual cause was printed, and then
 * discarded one branch earlier.
 *
 * Buffer-and-fold rather than stream-and-abort, deliberately: stderr is not a
 * reliable failure signal mid-turn. A Node `ExperimentalWarning`, a deprecation
 * notice, or any dependency's chatter all arrive on it during turns that go on
 * to succeed perfectly. Treating stderr output as an error would fail healthy
 * turns; ignoring it loses the diagnosis. So it is kept aside and attached only
 * to an error the route was already going to throw, where it costs nothing if
 * it turns out to be noise.
 */

/**
 * Max stderr characters folded into one error message.
 *
 * Bounded because this string travels to the browser inside an SSE `error`
 * event. A crash loop can emit megabytes of repeated stack traces, and the
 * first couple of thousand characters contain the cause in every realistic
 * case.
 */
export const MAX_STDERR_CHARS = 2000

/**
 * Append captured stderr to a base error message.
 *
 * Returns `base` unchanged when nothing was captured, or when what was captured
 * is only whitespace — appending an empty `stderr:` heading would imply the
 * sandbox said something when it did not, which is its own small lie to debug
 * around later.
 */
export function appendStderr(base: string, stderrChunks: readonly string[]): string {
  if (stderrChunks.length === 0) return base
  const stderr = stderrChunks.join("").trim()
  if (!stderr) return base
  const body =
    stderr.length > MAX_STDERR_CHARS
      ? `${stderr.slice(0, MAX_STDERR_CHARS)}… (truncated, ${stderr.length} chars total)`
      : stderr
  return `${base}\n\nstderr:\n${body}`
}

/**
 * A bounded accumulator for sandbox stderr.
 *
 * The turn route already caps its stdout buffer at 1MB, because a sandbox is
 * untrusted with respect to volume: it can emit as much as it likes, for as
 * long as the turn runs. Stderr needs the same ceiling for the same reason — a
 * process in a crash/retry loop can print the same stack trace thousands of
 * times, and an unbounded array of those chunks is a memory leak living inside
 * a request handler.
 *
 * Retains a prefix rather than a sliding window: the first stderr output is
 * where the original cause is, and later output is usually consequences of it.
 * Once full, further chunks are counted and dropped, and the count is reported
 * so a reader is never silently shown a partial picture.
 */
export class BoundedStderr {
  private chunks: string[] = []
  private kept = 0
  private dropped = 0

  constructor(private readonly limit: number = MAX_STDERR_CHARS * 4) {}

  push(chunk: string): void {
    const room = this.limit - this.kept
    if (room <= 0) {
      this.dropped += chunk.length
      return
    }
    if (chunk.length <= room) {
      this.chunks.push(chunk)
      this.kept += chunk.length
      return
    }
    this.chunks.push(chunk.slice(0, room))
    this.kept += room
    this.dropped += chunk.length - room
  }

  /** Fold what was captured into `base`, noting anything dropped at the cap. */
  toMessage(base: string): string {
    const message = appendStderr(base, this.chunks)
    if (this.dropped === 0 || message === base) return message
    return `${message}\n… (${this.dropped} further stderr chars dropped at the capture limit)`
  }
}
