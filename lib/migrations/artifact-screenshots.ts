import type { PoolClient } from "pg"

/**
 * Postconditions for migration 064_artifact_screenshots (ADR-0019).
 *
 * Seven additive, nullable columns on artifact_revisions. Every one must be
 * nullable with no default: DSQL rejects a constraint on ALTER TABLE ADD COLUMN,
 * and "this revision has no captured screenshot" is the normal state for every
 * row that already exists. A column that came back NOT NULL would mean someone
 * applied different DDL than the migration in this repo.
 */
const TABLE = "artifact_revisions"

type ExpectedColumn = { name: string; type: string; length: number | null }

const EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { name: "thumbnail_pathname", type: "text", length: null },
  { name: "thumbnail_mime_type", type: "character varying", length: 100 },
  { name: "thumbnail_byte_size", type: "integer", length: null },
  { name: "thumbnail_width", type: "integer", length: null },
  { name: "thumbnail_height", type: "integer", length: null },
  { name: "thumbnail_captured_at", type: "timestamp without time zone", length: null },
  { name: "thumbnail_source_url", type: "text", length: null },
]

/**
 * Read-only catalog evidence, independent of the migration receipt — so a
 * drifted schema is reported as drift rather than hidden behind a receipt that
 * says "applied".
 */
export async function getArtifactScreenshotsHealth(
  client: PoolClient,
  schema: string,
  receiptApplied = false
) {
  const columns = await client.query<{
    column_name: string
    data_type: string
    character_maximum_length: number | null
    is_nullable: string
    column_default: string | null
  }>(
    "SELECT column_name, data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, TABLE]
  )
  const byName = new Map(columns.rows.map(row => [row.column_name, row]))

  const missingColumns = EXPECTED_COLUMNS.filter(column => !byName.has(column.name)).map(
    column => column.name
  )
  const invalidColumns = EXPECTED_COLUMNS.filter(column => {
    const row = byName.get(column.name)
    if (!row) return false
    return (
      row.data_type !== column.type ||
      row.character_maximum_length !== column.length ||
      row.is_nullable !== "YES" ||
      row.column_default !== null
    )
  }).map(column => column.name)

  const ready = missingColumns.length === 0 && invalidColumns.length === 0
  // "absent" only when the table exists but none of the columns do. A missing
  // table is NOT absent — it means an earlier migration never ran, which is a
  // different problem and must not be reported as "nothing to do here yet".
  const tableExists = columns.rows.length > 0
  const absent = tableExists && EXPECTED_COLUMNS.every(column => !byName.has(column.name))

  return {
    status: ready ? "complete" : absent ? "absent" : "partial",
    ready,
    tableExists,
    receiptApplied,
    drift: receiptApplied && !ready,
    missingColumns,
    invalidColumns,
  }
}

export async function assertArtifactScreenshotsMigration(client: PoolClient, schema: string) {
  const health = await getArtifactScreenshotsHealth(client, schema)
  if (!health.tableExists) {
    throw new Error(
      `Migration 064 cannot be verified: table ${TABLE} does not exist in schema ${schema} (an earlier Artifact migration has not been applied)`
    )
  }
  if (!health.ready) {
    throw new Error(
      `Migration 064 catalog incomplete: missing columns [${health.missingColumns.join(", ")}]; ` +
        `invalid columns (type/length/nullability/default) [${health.invalidColumns.join(", ")}]`
    )
  }
}
