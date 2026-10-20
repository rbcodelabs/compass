import { AsyncLocalStorage } from "node:async_hooks"

/**
 * In-process, per-task write ordering for status updates.
 *
 * captureWorkspaceMutation reads a task's previous status and then writes the new one without a row lock
 * (Aurora DSQL has no SELECT ... FOR UPDATE, and the app uses optimistic concurrency). Two overlapping
 * updates to one task can therefore both read the same stale "before" and hide a real DONE <-> active flip
 * from the Doc comment thread sync. Running one task's updates through this chain makes each "before" see
 * the previous write. It cannot order writes across separate server instances; the thread sync's
 * re-check-after-write loop covers what is left.
 *
 * Re-entrant: a task update started from inside another update to the same task (same async context) runs
 * straight through instead of waiting on itself.
 */
const held = new AsyncLocalStorage<Set<string>>()
const chains = new Map<string, Promise<unknown>>()

export async function withTaskWriteLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const mine = held.getStore()
  if (mine?.has(taskId)) return work()

  const previous = chains.get(taskId) ?? Promise.resolve()
  const run = async () => held.run(new Set([...(mine ?? []), taskId]), work)
  const next = previous.then(run, run)
  chains.set(taskId, next)
  try {
    return await next
  } finally {
    if (chains.get(taskId) === next) chains.delete(taskId)
  }
}
