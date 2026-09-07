import { failureCode } from "./lifecycle"

export async function collectWorkerLogs(lines: AsyncIterable<{ stream: string; data: string }>, record: (entry: Record<string, unknown>) => void, evidence: WorkerEvidence) {
  let buffered = ""; let bytes = 0
  for await (const line of lines) {
    if (line.stream !== "stdout") continue // raw provider/runtime errors never forwarded
    bytes += Buffer.byteLength(line.data)
    if (bytes > 64 * 1024) throw new Error("WORKER_LOG_OVERFLOW")
    buffered += line.data
    let newline: number
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const entry = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
      buffered = buffered.slice(newline + 1)
      record(entry)
      evidence.accept(entry)
    }
  }
  if (buffered || !evidence.complete()) throw new Error("WORKER_EXITED_WITHOUT_PROOF")
}

export class WorkerEvidence {
  private initialized = false
  private exchanged = false
  private stopped = false
  private failure: Error | null = null
  accept(entry: Record<string, unknown>) {
    if (entry.kind === "failure") this.fail(new Error(typeof entry.code === "string" ? entry.code : "WORKER_FAILED"))
    if (entry.kind === "premedia" && entry.status === "ROOT_AND_POLICY_OBSERVED") this.initialized = true
    if (entry.kind === "complete" && entry.status === "SYNTHETIC_EXCHANGE_OBSERVED") this.exchanged = true
    if (entry.kind === "provider_stop" && entry.status === "STOPPED") this.stopped = true
  }
  fail(error: unknown) { this.failure ??= new Error(failureCode(error)) }
  ready() { if (this.failure) throw this.failure; return this.initialized }
  complete() { if (this.failure) throw this.failure; return this.exchanged && this.stopped }
  // Cleanup proof survives a later protocol failure; it is not readiness evidence.
  providerStopped() { return this.stopped }
}
