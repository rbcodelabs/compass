export type ProbeAdapters = {
  record(entry: Record<string, unknown>): void
  createProvider(signal: AbortSignal): Promise<void>
  createSandbox(signal: AbortSignal): Promise<void>
  startWorker(signal: AbortSignal): Promise<void>
  waitReady(signal: AbortSignal): Promise<void>
  releaseBrowser(signal: AbortSignal): Promise<void>
  waitComplete(signal: AbortSignal): Promise<void>
  stopProvider(signal: AbortSignal): Promise<boolean>
  stopSandbox(signal: AbortSignal): Promise<boolean>
  closeBrowser(): Promise<void>
}
export function failureCode(error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : "PROBE_OPERATION_FAILED"
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number, code: string): Promise<T> {
  const controller = new AbortController()
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(code)
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(code)) }, remaining)
    })])
  } finally { clearTimeout(timer!) }
}

export async function executeProbe(io: ProbeAdapters, durationMs = 120_000) {
  if (durationMs <= 0 || durationMs > 120_000) throw new Error("INVALID_PROBE_DURATION")
  const started = Date.now(); const deadline = started + durationMs
  const workDeadline = deadline - Math.min(30_000, durationMs / 4)
  let providerAttempted = false; let sandboxAttempted = false
  let phase = "PREFLIGHT"; let outcome = "PROOF_OBSERVED"
  let providerStopped = false; let sandboxStopped = false
  let browserStopped = false
  const creations: Promise<void>[] = []
  try {
    const steps = [
      ["PROVIDER_CREATE", io.createProvider], ["SANDBOX_CREATE", io.createSandbox],
      ["WORKER_START", io.startWorker], ["PREMEDIA_INITIALIZATION", io.waitReady],
      ["BROWSER_MEDIA", io.releaseBrowser], ["PARTICIPANT_FINALIZATION", io.waitComplete],
    ] as const
    for (const [nextPhase, operation] of steps) {
      phase = nextPhase
      io.record({ kind: "phase", phase, elapsedMs: Date.now() - started })
      if (phase === "PROVIDER_CREATE") providerAttempted = true
      if (phase === "SANDBOX_CREATE") sandboxAttempted = true
      await bounded((signal) => {
        const promise = operation(signal)
        if (phase === "PROVIDER_CREATE" || phase === "SANDBOX_CREATE") creations.push(promise)
        return promise
      }, Math.min(workDeadline, Date.now() + (phase === "PREMEDIA_INITIALIZATION" ? 30_000 : 20_000)),
        phase === "PREMEDIA_INITIALIZATION" ? "PREMEDIA_NOT_DEMONSTRATED" : "PROBE_DEADLINE_EXCEEDED")
    }
  } catch (error) { outcome = failureCode(error) }
  finally {
    // No dependency between cleanup requests: a hangup failure cannot skip stop.
    const stop = (prior: PromiseSettledResult<boolean>[] = []) => Promise.allSettled([
      providerAttempted && !(prior[0]?.status === "fulfilled" && prior[0].value) ? bounded(io.stopProvider, Math.min(deadline, Date.now() + 10_000), "CLEANUP_UNRESOLVED") : Promise.resolve(true),
      sandboxAttempted && !(prior[1]?.status === "fulfilled" && prior[1].value) ? bounded(io.stopSandbox, Math.min(deadline, Date.now() + 10_000), "CLEANUP_UNRESOLVED") : Promise.resolve(true),
    ])
    let results = await stop()
    // An SDK can finish an already-dispatched create after its work deadline.
    // Keep the journal open, let known IDs settle within the cleanup reserve,
    // and retry cleanup only (never worker/start/allocation) if needed.
    await bounded(() => Promise.allSettled(creations), deadline - Math.min(10_000, durationMs / 10), "LATE_CREATE_UNRESOLVED").catch(() => {})
    if (results.some((result) => result.status !== "fulfilled" || result.value !== true)) results = await stop(results)
    providerStopped = results[0].status === "fulfilled" && results[0].value === true
    sandboxStopped = results[1].status === "fulfilled" && results[1].value === true
    try { await bounded(() => io.closeBrowser(), Math.min(deadline, Date.now() + 5_000), "BROWSER_CLOSE_UNRESOLVED"); browserStopped = true } catch { /* Report uncertainty. */ }
    io.record({ kind: "result", phase, code: outcome, providerStopped, sandboxStopped, browserStopped, elapsedMs: Date.now() - started })
  }
  return { outcome, phase, providerStopped, sandboxStopped, browserStopped }
}
