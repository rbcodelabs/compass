export type DsqlBackfillRow = { id: string; estimatedBytes: number }

export function planDsqlWriteBatch(
  rows: DsqlBackfillRow[],
  limits: { maxRows: number; maxBytes: number },
): DsqlBackfillRow[] {
  const batch: DsqlBackfillRow[] = []
  let bytes = 0
  for (const row of rows) {
    if (row.estimatedBytes > limits.maxBytes) {
      throw new Error(`Row ${row.id} exceeds Aurora DSQL's transaction byte limit.`)
    }
    if (batch.length >= limits.maxRows || bytes + row.estimatedBytes > limits.maxBytes) break
    batch.push(row)
    bytes += row.estimatedBytes
  }
  return batch
}
