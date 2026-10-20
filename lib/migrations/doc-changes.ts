import type { PoolClient } from "pg"

export const DOC_CHANGES_TABLE = "doc_changes"
export const DOC_CHANGES_INDEX = "idx_doc_changes_workspace_seq"

/** Columns 092_doc_changes must leave behind, with their nullability. */
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

/**
 * Postcondition run before the migration's completion receipt is written. The unique
 * (workspace_id, seq) index is what keeps the sequence monotonic under concurrent writers, so an
 * async build that never finished (or a drifted table) fails closed.
 */
export async function assertDocChangesMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, DOC_CHANGES_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 092 postcondition failed: ${DOC_CHANGES_TABLE}.${column} is missing or has the wrong nullability`)
    }
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
