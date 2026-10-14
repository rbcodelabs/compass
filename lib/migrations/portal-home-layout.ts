import type { PoolClient } from "pg"

/** Columns 074_portal_home_layout must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "draft_widgets", nullable: false },
  // NULL until the first publish: no published layout means "render the default home".
  { column: "published_widgets", nullable: true },
  { column: "published_at", nullable: true },
  { column: "published_by_id", nullable: true },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
]

export const PORTAL_HOME_LAYOUT_INDEX = {
  name: "idx_portal_home_layouts_workspace",
  table: "portal_home_layouts",
  columns: "workspace_id",
} as const

/**
 * Postcondition run before the migration's completion receipt is written. The
 * unique workspace index is what guarantees one layout row per workspace, so an
 * async build that never finished (or a drifted table) fails closed instead of
 * letting two admins create competing rows.
 */
export async function assertPortalHomeLayoutMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, PORTAL_HOME_LAYOUT_INDEX.table],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 074 postcondition failed: portal_home_layouts.${column} is missing or has the wrong nullability`)
    }
  }
  const { name, table, columns } = PORTAL_HOME_LAYOUT_INDEX
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
    throw new Error(`Portal home layout migration index ${name} is not ready or has drifted`)
  }
}
