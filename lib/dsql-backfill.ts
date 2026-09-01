import type { PoolClient } from "pg"

export type DsqlBackfillRow = { id: string; estimatedBytes: number }

export const DSQL_WRITE_LIMITS = {
  maxRows: 3_000,
  maxBytes: 10 * 1024 * 1024,
} as const

function toSafeNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER
}

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

export async function backfillRoadmapCommitmentProvenance(
  client: PoolClient,
  schema: string,
  log: string[],
) {
  let totalUpdated = 0
  for (;;) {
    const { rows } = await client.query<{ id: string; estimated_bytes: string }>(`
      SELECT id, pg_column_size(ri)::bigint AS estimated_bytes
      FROM "${schema}".roadmap_items ri
      WHERE now_commitment_provenance IS NULL
      ORDER BY id
      LIMIT ${DSQL_WRITE_LIMITS.maxRows}
    `)
    if (rows.length === 0) break
    const batch = planDsqlWriteBatch(
      rows.map((row) => ({ id: row.id, estimatedBytes: toSafeNumber(row.estimated_bytes) })),
      DSQL_WRITE_LIMITS,
    )
    if (batch.length === 0) throw new Error("Migration 039 could not plan a safe provenance backfill batch.")
    await client.query("BEGIN")
    try {
      const result = await client.query(
        `UPDATE "${schema}".roadmap_items
         SET now_commitment_provenance = 'LEGACY_UNGATED'
         WHERE id = ANY($1::uuid[])
           AND now_commitment_provenance IS NULL`,
        [batch.map((row) => row.id)],
      )
      await client.query("COMMIT")
      totalUpdated += result.rowCount ?? 0
      log.push(`  ✓ provenance backfill batch: ${result.rowCount ?? 0} rows`)
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  }
  return totalUpdated
}
