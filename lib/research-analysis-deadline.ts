// Leave 30 seconds before claim reclamation for cancellation and database receipts.
export const analysisOperationMs = 150_000

export function assertAnalysisDeadline(deadline: number) {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Research analysis deadline exceeded")
}

/** Bounds one I/O step, not an async pipeline that could keep dispatching after timeout. */
export function analysisStep<T>(start: () => Promise<T>, deadline: number, controller: AbortController, onLate?: (value: T) => Promise<void>): Promise<T> {
  assertAnalysisDeadline(deadline)
  if (controller.signal.aborted) throw new Error("Research analysis deadline exceeded")
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
      reject(new Error("Research analysis deadline exceeded"))
    }, deadline - Date.now())
    Promise.resolve().then(() => {
      assertAnalysisDeadline(deadline)
      return start()
    }).then(async value => {
      clearTimeout(timer)
      if (expired || Date.now() >= deadline) {
        controller.abort()
        reject(new Error("Research analysis deadline exceeded"))
        // Allocation can finish after cancellation; reclaim it without running the next step.
        if (onLate) await onLate(value)
      } else resolve(value)
    }, error => { clearTimeout(timer); reject(error) }).catch(() => {
      console.error("Research analysis late cleanup failed")
    })
  })
}
