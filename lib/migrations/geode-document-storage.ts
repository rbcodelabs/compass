import type { PoolClient } from "pg"

const additive = ["docs.storage_provider", "docs.content_ref", "docs.revision", "doc_versions.storage_provider", "doc_versions.content_ref"]
const expected = [
  ...additive.map(name => ({ name, type: name.endsWith("storage_provider") ? "character varying" : name.endsWith("revision") ? "uuid" : "text", length: name.endsWith("storage_provider") ? 20 : null, nullable: true })),
  ...["id", "workspace_id", "operation_id", "doc_id", "payload_digest", "result", "created_at"].map(column => ({ name: `doc_operations.${column}`, type: column === "payload_digest" ? "character varying" : column === "result" ? "text" : column === "created_at" ? "timestamp without time zone" : "uuid", length: column === "payload_digest" ? 64 : null, nullable: false })),
  ...["id", "workspace_id", "pathname", "created_at"].map(column => ({ name: `doc_storage_objects.${column}`, type: column === "pathname" ? "text" : column === "created_at" ? "timestamp without time zone" : "uuid", length: null, nullable: false })),
]

/** Read-only catalog evidence, independent of migration receipts. Query errors propagate. */
export async function getGeodeDocumentStorageHealth(client: PoolClient, schema: string, receiptApplied = false) {
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null; data_type: string; character_maximum_length: number | null }>(
    "SELECT table_name, column_name, is_nullable, column_default, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["docs", "doc_versions", "doc_operations", "doc_storage_objects"]],
  )
  const byName = new Map(columns.rows.map(row => [`${row.table_name}.${row.column_name}`, row]))
  const missingColumns = expected.filter(column => !byName.has(column.name)).map(column => column.name)
  const invalidColumns = expected.filter(column => {
    const row = byName.get(column.name)
    if (!row) return false
    const defaultValid = column.name.endsWith(".created_at")
      ? /^(CURRENT_TIMESTAMP|now\(\))$/i.test(row.column_default ?? "")
      : row.column_default === null
    return row.data_type !== column.type || row.character_maximum_length !== column.length || row.is_nullable !== (column.nullable ? "YES" : "NO") || !defaultValid
  }).map(column => column.name)
  const indexes = await client.query<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null; expression: string | null }>(
    `SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, t.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_get_expr(i.indexprs, i.indrelid) AS expression
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, "doc_operations_workspace_id_operation_id_key"],
  )
  const index = indexes.rows[0]
  const indexValid = indexes.rows.length === 1 && index.valid && index.ready && index.unique && index.table_name === "doc_operations" && index.columns.join(",") === "workspace_id,operation_id" && index.predicate === null && index.expression === null
  const primaryKeys = await client.query<{ table_name: string; valid: boolean; ready: boolean; columns: string[] }>(
    `SELECT t.relname AS table_name, i.indisvalid AS valid, i.indisready AS ready,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS columns
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname = ANY($2::text[]) AND i.indisprimary`,
    [schema, ["doc_operations", "doc_storage_objects"]],
  )
  const invalidPrimaryKeys = ["doc_operations", "doc_storage_objects"].filter(table => {
    const keys = primaryKeys.rows.filter(row => row.table_name === table)
    return keys.length !== 1 || !keys[0].valid || !keys[0].ready || keys[0].columns.join(",") !== "id"
  })
  const ready = missingColumns.length === 0 && invalidColumns.length === 0 && indexValid && invalidPrimaryKeys.length === 0
  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["doc_operations", "doc_storage_objects"]],
  )
  const absent = expected.every(column => !byName.has(column.name)) && indexes.rows.length === 0 && tables.rows.length === 0
  return { status: ready ? "complete" : absent ? "absent" : "partial", ready, receiptApplied, drift: receiptApplied && !ready, missingColumns, invalidColumns, invalidPrimaryKeys, receiptIndexValid: indexValid }
}

export async function assertGeodeDocumentStorageMigration(client: PoolClient, schema: string) {
  const health = await getGeodeDocumentStorageHealth(client, schema)
  if (!health.ready) throw new Error(`Migration 059 catalog incomplete: missing columns [${health.missingColumns.join(", ")}]; invalid columns (type/nullability/default) [${health.invalidColumns.join(", ")}]; invalid primary keys [${health.invalidPrimaryKeys.join(", ")}]; receipt index valid=${health.receiptIndexValid}`)
}
