import type { PoolClient } from "pg"

export const DOC_CHANGES_TABLE = "doc_changes"
export const DOC_CHANGES_INDEX = "idx_doc_changes_workspace_seq"
export const DOC_CHANGE_COUNTERS_TABLE = "doc_change_counters"

/** Columns 100_doc_changes must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "doc_id", nullable: false },
  { column: "seq", nullable: false },
  { column: "kind", nullable: false },
  { column: "revision", nullable: true },
  { column: "path", nullable: false },
  { column: "deleted_at", nullable: true },
  { column: "created_at", nullable: false },
]

const EXPECTED_COUNTER_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "workspace_id", nullable: false },
  { column: "last_seq", nullable: false },
  { column: "epoch", nullable: false },
  { column: "dirty", nullable: false },
]

/**
 * Postcondition run before the migration's completion receipt is written. The unique
 * (workspace_id, seq) index is what keeps the sequence monotonic under concurrent writers, so an
 * async build that never finished (or a drifted table) fails closed.
 */
async function assertColumns(client: PoolClient, schema: string, table: string, expected: { column: string; nullable: boolean }[]) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, table],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of expected) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 100 postcondition failed: ${table}.${column} is missing or has the wrong nullability`)
    }
  }
}

export async function assertDocChangesMigration(client: PoolClient, schema: string) {
  await assertColumns(client, schema, DOC_CHANGES_TABLE, EXPECTED_COLUMNS)
  await assertColumns(client, schema, DOC_CHANGE_COUNTERS_TABLE, EXPECTED_COUNTER_COLUMNS)
  // The counter's primary key on workspace_id alone is what makes the increment-upsert atomic.
  const pk = await client.query<{ columns: string[] }>(
    `SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
       JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS columns
     FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=$1 AND t.relname=$2 AND i.indisprimary`,
    [schema, DOC_CHANGE_COUNTERS_TABLE],
  )
  if (pk.rows.length !== 1 || pk.rows[0].columns.join(",") !== "workspace_id") {
    throw new Error(`Migration 100 postcondition failed: ${DOC_CHANGE_COUNTERS_TABLE} must have a primary key on workspace_id alone`)
  }

  const index = await client.query<{
    valid: boolean
    ready: boolean
    unique: boolean
    table_name: string
    columns: string[]
    predicate: string | null
    expression: string | null
  }>(
    `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expression
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, DOC_CHANGES_INDEX],
  )
  const row = index.rows[0]
  if (
    index.rows.length !== 1 ||
    !row.valid ||
    !row.ready ||
    !row.unique ||
    row.table_name !== DOC_CHANGES_TABLE ||
    row.columns.join(",") !== "workspace_id,seq" ||
    row.predicate !== null ||
    row.expression !== null
  ) {
    throw new Error(`Doc changes migration index ${DOC_CHANGES_INDEX} is not ready or has drifted`)
  }
}
