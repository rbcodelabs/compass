import { closeSync, fsyncSync, openSync, writeSync } from "node:fs"

export function singleDispatchFetch(raw: typeof fetch): typeof fetch {
  const attempted = new Set<string>()
  return async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== "https://vercel.com" || !url.pathname.startsWith("/api/v2/sandboxes")) throw new Error("UNEXPECTED_SANDBOX_TARGET")
    const method = options?.method ?? (input instanceof Request ? input.method : "GET")
    const creates = method.toUpperCase() === "POST" && (url.pathname === "/api/v2/sandboxes" || /\/sessions\/[^/]+\/cmd$/.test(url.pathname))
    if (creates) {
      const kind = url.pathname === "/api/v2/sandboxes" ? "sandbox" : "command"
      if (attempted.has(kind)) throw new DOMException("CREATE_RETRY_BLOCKED", "AbortError")
      attempted.add(kind) // consume BEFORE dispatch, including transport errors
    }
    return raw(input, { ...options, redirect: "error" })
  }
}

export class ProbeJournal {
  private fd: number
  private count = 0
  constructor(path: string) {
    this.fd = openSync(path, "wx", 0o600)
    try { this.record({ kind: "claim", phase: "ATTEMPT_CONSUMED" }) }
    catch (error) { closeSync(this.fd); throw error }
  }
  record(entry: Record<string, unknown>) {
    const allowed = new Set(["kind", "phase", "code", "elapsedMs", "runId", "providerCallId", "sandboxName", "sandboxId", "commandId", "providerStopped", "sandboxStopped", "browserStopped", "estimatedUsd", "sha256", "bytes", "durationMs", "batchId", "role", "ordinal", "itemId", "previousItemId", "responseId", "status", "chars"])
    if (Object.entries(entry).some(([key, value]) => !allowed.has(key) ||
      !(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 255 && /^[A-Za-z0-9_.:-]+$/.test(value))))) throw new Error("UNSAFE_JOURNAL_FIELD")
    if (++this.count > 128) throw new Error("JOURNAL_OVERFLOW")
    writeSync(this.fd, JSON.stringify({ ...entry, recordedAt: new Date().toISOString() }) + "\n")
    fsyncSync(this.fd)
  }
  close() { closeSync(this.fd) }
}
