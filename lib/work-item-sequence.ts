import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import { WORK_ITEM_REGISTRY, type WorkItemType } from "@/lib/work-item-ids"

/**
 * The only way to get a work item number (ADR "Human-readable work item IDs", section 4).
 *
 * `allocateSeq` increments the (workspace, type) counter row in `workspace_sequences` and returns the
 * numbers it reserved. It MUST run in the same transaction as the insert that uses them:
 *   - PostgreSQL: the increment takes a row lock, so concurrent creators serialize; a rolled-back
 *     create undoes the increment, so numbers stay dense. The first-row race raises P2002.
 *   - Aurora DSQL (optimistic): two transactions touching the counter row conflict at commit
 *     (OC000/OC001/40001) and the loser retries. The unique index on
 *     (workspace_id, seq_prefix, seq_number) is a second line of defence.
 * Both failure shapes are replayed by `withSequenceTransaction`, which wraps retryUpdatesTransaction.
 *
 * It never opens a transaction of its own: callers that already hold one (an MCP tool receipt
 * transaction) pass it in.
 */
export type SeqRange = {
  seqPrefix: string
  /** `count` consecutive numbers, ascending. */
  seqNumbers: number[]
}

export type SeqColumns = { seqPrefix: string; seqNumber: number }

export async function allocateSeq(
  tx: AppTransactionClient,
  workspaceId: string,
  type: WorkItemType,
  count = 1,
): Promise<SeqRange> {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`allocateSeq count must be a positive integer, got ${count}`)
  if (!workspaceId) throw new Error("allocateSeq requires a workspaceId")
  const counter = await tx.workspaceSequence.upsert({
    where: { workspaceId_entityType: { workspaceId, entityType: type } },
    // A fresh counter hands out 1..count, so the next free number is count + 1.
    create: { workspaceId, entityType: type, nextValue: count + 1 },
    update: { nextValue: { increment: count } },
  })
  const first = counter.nextValue - count
  if (first < 1) throw new Error(`workspace_sequences returned an impossible counter for ${type}: ${counter.nextValue}`)
  return {
    seqPrefix: WORK_ITEM_REGISTRY[type].prefix,
    seqNumbers: Array.from({ length: count }, (_, index) => first + index),
  }
}

/** One number, shaped for spreading into a Prisma `create` payload: `data: { ..., ...(await allocateOneSeq(...)) }`. */
export async function allocateOneSeq(tx: AppTransactionClient, workspaceId: string, type: WorkItemType): Promise<SeqColumns> {
  const { seqPrefix, seqNumbers } = await allocateSeq(tx, workspaceId, type, 1)
  return { seqPrefix, seqNumber: seqNumbers[0] }
}

/** Pairs a range with its rows for `createMany`: row `i` gets number `i`. */
export function withSeq<T extends object>(range: SeqRange, rows: readonly T[]): (T & SeqColumns)[] {
  if (rows.length !== range.seqNumbers.length) {
    throw new RangeError(`Allocated ${range.seqNumbers.length} numbers for ${rows.length} rows`)
  }
  return rows.map((row, index) => ({ ...row, seqPrefix: range.seqPrefix, seqNumber: range.seqNumbers[index] }))
}

/**
 * Runs `callback` in a transaction that is replayed on a DSQL commit conflict or the first-row race
 * on the counter. Inside an existing MCP tool transaction it reuses that transaction (no replay),
 * exactly like retryUpdatesTransaction. The callback must be safe to run again from the top.
 */
export function withSequenceTransaction<T>(
  prisma: AppPrismaClient,
  callback: (tx: AppTransactionClient) => Promise<T>,
): Promise<T> {
  return retryUpdatesTransaction(prisma, callback)
}
