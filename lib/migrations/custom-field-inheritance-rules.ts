import type { PoolClient } from "pg"

const TABLE = "custom_field_inheritance_rules"

/** Columns 113_custom_field_inheritance_rules must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "target_object_type", nullable: false },
  { column: "target_field_id", nullable: false },
  { column: "source_object_type", nullable: false },
  { column: "source_field_id", nullable: false },
  { column: "priority", nullable: false },
  { column: "enabled", nullable: false },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
  { column: "created_by_id", nullable: true },
  { column: "updated_by_id", nullable: true },
  { column: "source", nullable: false },
]

export const CUSTOM_FIELD_INHERITANCE_INDEXES = [
  { name: "idx_cfir_target_priority", unique: true, columns: "workspace_id,target_field_id,priority" },
  { name: "idx_cfir_target_source", unique: true, columns: "workspace_id,target_field_id,source_field_id" },
  { name: "idx_cfir_workspace_target_type", unique: false, columns: "workspace_id,target_object_type" },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. A drifted table or an async index
 * that never finished building fails closed, so the receipt is never recorded for a half-built table.
 */
export async function assertCustomFieldInheritanceRulesMigration(client: Pick<PoolClient, "query">, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 113 postcondition failed: ${TABLE}.${column} is missing or has the wrong nullability`)
    }
  }
  for (const { name, unique, columns } of CUSTOM_FIELD_INHERITANCE_INDEXES) {
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
      row.unique !== unique ||
      row.table_name !== TABLE ||
      row.columns.join(",") !== columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`Custom field inheritance rules migration index ${name} is not ready or has drifted`)
    }
  }
}
