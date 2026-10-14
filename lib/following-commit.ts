import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Commit-scoped queue for following side effects (ADR "Following and in-app
 * notifications", section 2.6: fan-out runs AFTER the source mutation commits).
 *
 * Most mutations commit before the adapter returns, so their effects can run
 * immediately. MCP tools that run inside the PM interview receipt transaction
 * cannot: "after the adapter returns" is still inside the transaction there, so
 * a follower could be told about a change that then rolls back, and a freshly
 * created subject is not yet visible to the fan-out's own queries. Wrapping that
 * transaction in `withFollowingCommit` makes `runAfterCommit` queue instead, and
 * flushes the queue only once the wrapped work resolved (the transaction
 * committed). A throw discards the queue, which is exactly the rollback case.
 * Same shape as `withActivityCommit` in lib/analytics/activity.ts.
 */
type Work = () => Promise<unknown>

const scope = new AsyncLocalStorage<Work[]>()

async function runSafely(work: Work): Promise<void> {
  try {
    await work()
  } catch (error) {
    // Effects are best-effort by contract and never fail the caller's request.
    console.error("[following] post-commit work failed", error)
  }
}

export async function withFollowingCommit<T>(handler: () => Promise<T>): Promise<T> {
  const queue: Work[] = []
  const result = await scope.run(queue, handler)
  for (const work of queue) await runSafely(work)
  return result
}

/** Queue while inside a commit scope, otherwise run now. Never throws. */
export async function runAfterCommit(work: Work): Promise<void> {
  const queue = scope.getStore()
  if (queue) {
    queue.push(work)
    return
  }
  await runSafely(work)
}
