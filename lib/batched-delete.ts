/**
 * Bounded deletes for tables that can hold more rows than one transaction may touch.
 *
 * Aurora DSQL fails a transaction that modifies more than ~3,000 rows, and the plain-Postgres
 * backend is happier with short statements too, so every unbounded `deleteMany({ where })` on a
 * user-sized or time-sized table goes through here instead: select a page of ids, delete exactly
 * those ids, repeat. Each iteration is its own statement (its own transaction), and the loop is
 * safe to re-run after a crash because every row it removes leaves the matched set.
 */

/** Well under DSQL's 3,000-rows-per-transaction ceiling, even with secondary indexes per row. */
export const DELETE_BATCH_SIZE = 500

type IdDelegate = {
  findMany(args: { where: Record<string, unknown>; select: { id: true }; take: number }): Promise<{ id: string }[]>
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>
}

/** Prisma reports a table that has not been migrated into this schema yet as P2021. */
export function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2021"
}

/**
 * Deletes every row matching `where`, a page at a time. Returns the number deleted.
 * `limit` stops after roughly that many rows (rounded up to a whole page) and `deadline` (epoch ms) stops before
 * starting another page, so a time-boxed caller (the retention cron) can leave the rest for its next run.
 */
export async function deleteInBatches(
  delegate: unknown,
  where: Record<string, unknown>,
  options: { batchSize?: number; limit?: number; deadline?: number } = {},
): Promise<number> {
  const table = delegate as IdDelegate
  const batchSize = options.batchSize ?? DELETE_BATCH_SIZE
  let total = 0
  for (;;) {
    if (options.limit !== undefined && total >= options.limit) return total
    if (options.deadline !== undefined && Date.now() >= options.deadline) return total
    const rows = await table.findMany({ where, select: { id: true }, take: batchSize })
    if (rows.length === 0) return total
    const result = await table.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
    total += result.count
    if (rows.length < batchSize) return total
  }
}

/** Splits a list into pages for `{ in: [...] }` filters. */
export function pages<T>(list: readonly T[], size: number = DELETE_BATCH_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

type IdUpdateDelegate = {
  findMany(args: { where: Record<string, unknown>; select: { id: true }; take: number }): Promise<{ id: string }[]>
  updateMany(args: { where: { id: { in: string[] } }; data: Record<string, unknown> }): Promise<{ count: number }>
}

/**
 * Bounded `updateMany`. `where` MUST exclude rows that already carry the new value (for example
 * `authorName: { not: "Deleted user" }`); that is what makes each page leave the matched set and the loop end.
 */
export async function updateInBatches(
  delegate: unknown,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  batchSize: number = DELETE_BATCH_SIZE,
): Promise<number> {
  const table = delegate as IdUpdateDelegate
  let total = 0
  for (;;) {
    const rows = await table.findMany({ where, select: { id: true }, take: batchSize })
    if (rows.length === 0) return total
    const result = await table.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data })
    total += result.count
    if (rows.length < batchSize) return total
  }
}
