/**
 * Re-running a transaction that lost a write conflict (see `isDsqlWriteConflict`: Prisma P2034, SQLSTATE 40001, or a DSQL
 * OC00x message). The caller's transaction must be idempotent (it re-reads what it decides on). The conflict is surfaced only
 * if it persists after `attempts` tries; anything that is not a conflict is never retried.
 */
import { isDsqlWriteConflict } from "@/lib/dsql-conflict"

export const TRANSACTION_CONFLICT_ATTEMPTS = 3

export async function withConflictRetry<T>(work: () => Promise<T>, attempts = TRANSACTION_CONFLICT_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      if (!isDsqlWriteConflict(error) || attempt >= attempts) throw error
    }
  }
}
