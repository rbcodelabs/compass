import type { PoolClient } from "pg"

export const ENTITY_LINKS_TABLE = "entity_links"

/** Columns 091_entity_links must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "link_type", nullable: false },
  { column: "from_type", nullable: false },
  { column: "from_id", nullable: false },
  { column: "to_type", nullable: false },
  { column: "to_id", nullable: false },
  { column: "origin", nullable: false },
  { column: "source", nullable: false },
  { column: "created_by_id", nullable: true },
  { column: "attrs", nullable: true },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
]

export const ENTITY_LINK_INDEXES = [
  // One link of a type per ordered pair. Entity ids are UUIDs, so (from_id, link_type, to_id) is
  // unambiguous without the entity type names.
  { name: "idx_entity_links_pair", columns: "from_id,link_type,to_id", unique: true },
  // Reverse lookup: "what points at this entity".
  { name: "idx_entity_links_reverse", columns: "to_id,link_type,from_id", unique: false },
  // Workspace-scoped listing and per-type integrity scans.
  { name: "idx_entity_links_workspace", columns: "workspace_id,link_type", unique: false },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique pair
 * index is what stops duplicate links, so an async build that never finished (or a drifted
 * table) fails closed instead of letting concurrent writers create duplicates later.
 */
export async function assertEntityLinksMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, ENTITY_LINKS_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 091 postcondition failed: ${ENTITY_LINKS_TABLE}.${column} is missing or has the wrong nullability`)
    }
  }

  for (const expected of ENTITY_LINK_INDEXES) {
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
      [schema, expected.name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      row.unique !== expected.unique ||
      row.table_name !== ENTITY_LINKS_TABLE ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`Entity links migration index ${expected.name} is not ready or has drifted`)
    }
  }
}
