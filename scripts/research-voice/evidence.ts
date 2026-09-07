import { failureCode } from "./lifecycle"

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
