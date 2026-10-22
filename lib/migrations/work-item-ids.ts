import type { PoolClient } from "pg"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES } from "@/lib/work-item-ids"

export const WORK_ITEM_IDS_MIGRATION = "092_work_item_ids"
export const WORKSPACE_SEQUENCES_TABLE = "workspace_sequences"

/** Tables that gain a nullable workspace_id because they only reached it through a parent. */
const NEW_WORKSPACE_ID_TABLES = ["key_results", "assumptions"] as const

type ExpectedColumn = { table: string; column: string; nullable: boolean; dataType: string }

const SEQUENCE_COLUMNS: ExpectedColumn[] = [
  { table: WORKSPACE_SEQUENCES_TABLE, column: "workspace_id", nullable: false, dataType: "uuid" },
  { table: WORKSPACE_SEQUENCES_TABLE, column: "entity_type", nullable: false, dataType: "character varying" },
  { table: WORKSPACE_SEQUENCES_TABLE, column: "next_value", nullable: false, dataType: "integer" },
  { table: WORKSPACE_SEQUENCES_TABLE, column: "updated_at", nullable: false, dataType: "timestamp without time zone" },
]

export function workItemIdIndexName(table: string): string {
  return `idx_${table}_seq`
}

function expectedColumns(): ExpectedColumn[] {
  const columns: ExpectedColumn[] = []
  for (const type of WORK_ITEM_TYPES) {
    const { table } = WORK_ITEM_REGISTRY[type]
    columns.push({ table, column: "seq_prefix", nullable: true, dataType: "character varying" })
    columns.push({ table, column: "seq_number", nullable: true, dataType: "integer" })
  }
  for (const table of NEW_WORKSPACE_ID_TABLES) {
    columns.push({ table, column: "workspace_id", nullable: true, dataType: "uuid" })
  }
  return [...columns, ...SEQUENCE_COLUMNS]
}

export function expectedWorkItemIndexes(): { name: string; table: string; columns: string; unique: boolean }[] {
  const indexes = WORK_ITEM_TYPES.map((type) => {
    const { table } = WORK_ITEM_REGISTRY[type]
    return { name: workItemIdIndexName(table), table, columns: "workspace_id,seq_prefix,seq_number", unique: true }
  })
  for (const table of NEW_WORKSPACE_ID_TABLES) {
    indexes.push({ name: `idx_${table}_workspace_id`, table, columns: "workspace_id", unique: false })
  }
  return indexes
}

/**
 * Postcondition run before the 092 receipt. The unique indexes are what stop duplicate numbers when
 * two writers race, so an async build that never finished (or a drifted table) fails closed.
 */
export async function assertWorkItemIdsMigration(client: PoolClient, schema: string) {
  const expected = expectedColumns()
  const tables = [...new Set(expected.map((column) => column.table))]
  const result = await client.query<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>(
    "SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, tables],
  )
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  for (const { table, column, nullable, dataType } of expected) {
    const row = actual.get(`${table}.${column}`)
    if (!row || (row.is_nullable === "YES") !== nullable || row.data_type !== dataType) {
      throw new Error(`Migration 092 postcondition failed: ${table}.${column} is missing or has the wrong type or nullability`)
    }
  }

  // Key columns only: on Aurora DSQL the primary-key index also carries the remaining columns as
  // INCLUDEd attributes, which sit past indnkeyatts and must not be compared.
  const pk = await client.query<{ columns: string[] }>(
    `SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns
     FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=$1 AND t.relname=$2 AND i.indisprimary`,
    [schema, WORKSPACE_SEQUENCES_TABLE],
  )
  if (pk.rows.length !== 1 || pk.rows[0].columns.join(",") !== "workspace_id,entity_type") {
    throw new Error(`Migration 092 postcondition failed: ${WORKSPACE_SEQUENCES_TABLE} primary key is missing or has drifted`)
  }

  for (const want of expectedWorkItemIndexes()) {
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
      [schema, want.name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      row.unique !== want.unique ||
      row.table_name !== want.table ||
      row.columns.join(",") !== want.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`Work item IDs migration index ${want.name} is not ready or has drifted`)
    }
  }
}
