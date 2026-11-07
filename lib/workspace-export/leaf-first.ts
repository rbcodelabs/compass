import { isDsqlWriteConflict } from "@/lib/dsql-conflict"
import type { Delegate } from "@/lib/workspace-export/scope"

/** Retries a statement that lost a write conflict (Aurora DSQL optimistic concurrency). */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= 5 || !isDsqlWriteConflict(error)) throw error
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
    }
  }
}

export const isRestrictViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2014"

export class StuckDeleteError extends Error {}

/**
 * Deletes rows by id. Self-referencing models (comment replies, doc trees, subtasks) trip Prisma's emulated Restrict when a
 * parent and its children go in one statement (P2014), even though every row is being deleted. On P2014 fall back to repeated
 * passes, one row at a time, so each pass removes the rows whose children are already gone.
 */
export async function deleteIdsLeafFirst(delegate: Delegate, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await withRetry(() => delegate.deleteMany({ where: { id: { in: ids } } }))
    return
  } catch (error) {
    if (!isRestrictViolation(error)) throw error
  }
  let pending = ids
  while (pending.length) {
    const next: string[] = []
    for (const id of pending) {
      try {
        await withRetry(() => delegate.deleteMany({ where: { id } }))
      } catch (error) {
        if (!isRestrictViolation(error)) throw error
        next.push(id)
      }
    }
    if (next.length === pending.length) throw new StuckDeleteError(`Could not delete ${next.length} row(s): something still references them`)
    pending = next
  }
}
