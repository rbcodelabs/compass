/**
 * Whether a database error is a write conflict the caller may treat as "someone else got there first": Prisma P2034, SQLSTATE
 * 40001 (directly or in `meta`), or Aurora DSQL's optimistic-concurrency text (OC000/OC001...) and serialization failures. DSQL
 * aborts the loser of two concurrent writes to the same row with one of these, where Postgres would have made it wait.
 */
export function isDsqlWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const value = error as { code?: string; meta?: { code?: string }; message?: string }
  return value.code === "P2034" || value.code === "40001" || value.meta?.code === "40001" || /OC00\d|serialization/i.test(value.message ?? "")
}
