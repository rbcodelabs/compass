import type { PoolClient } from "pg"

/** Columns 080_organization_slug_redirects must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "organization_id", nullable: false },
  { column: "old_slug", nullable: false },
  { column: "created_at", nullable: false },
]

export const ORGANIZATION_SLUG_REDIRECTS_INDEX = {
  name: "idx_organization_slug_redirects_old_slug",
  table: "organization_slug_redirects",
  columns: "old_slug",
} as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique
 * old_slug index is what stops two organizations reserving the same retired slug, so an
 * async build that never finished (or a drifted table) fails closed.
 */
export async function assertOrganizationSlugRedirectsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, ORGANIZATION_SLUG_REDIRECTS_INDEX.table],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 080 postcondition failed: organization_slug_redirects.${column} is missing or has the wrong nullability`)
    }
  }
  const { name, table, columns } = ORGANIZATION_SLUG_REDIRECTS_INDEX
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
    [schema, name],
  )
  const row = index.rows[0]
  if (
    index.rows.length !== 1 ||
    !row.valid ||
    !row.ready ||
    !row.unique ||
    row.table_name !== table ||
    row.columns.join(",") !== columns ||
    row.predicate !== null ||
    row.expression !== null
  ) {
    throw new Error(`Organization slug redirects migration index ${name} is not ready or has drifted`)
  }
}
