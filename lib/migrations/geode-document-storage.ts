import type { PoolClient } from "pg"

const additive = ["docs.storage_provider", "docs.content_ref", "docs.revision", "doc_versions.storage_provider", "doc_versions.content_ref"]
const required = [...additive, ...["id", "workspace_id", "operation_id", "doc_id", "payload_digest", "result", "created_at"].map(c => `doc_operations.${c}`), ...["id", "workspace_id", "pathname", "created_at"].map(c => `doc_storage_objects.${c}`)]

export async function assertGeodeDocumentStorageMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
    "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["docs", "doc_versions", "doc_operations", "doc_storage_objects"]],
  )
  const byName = new Map(columns.rows.map(row => [`${row.table_name}.${row.column_name}`, row]))
  const missing = required.filter(name => !byName.has(name))
  if (missing.length) throw new Error(`Migration 059 missing columns: ${missing.join(", ")}`)
  if (additive.some(name => byName.get(name)!.is_nullable !== "YES" || byName.get(name)!.column_default !== null)) throw new Error("Migration 059 storage columns must be nullable with no defaults")
  const indexes = await client.query<{ valid: boolean; unique: boolean }>(
    "SELECT i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
    [schema, "doc_operations_workspace_id_operation_id_key"],
  )
  if (indexes.rows.length !== 1 || !indexes.rows[0].valid || !indexes.rows[0].unique) throw new Error("Migration 059 receipt index must exist, be valid and unique")
}
