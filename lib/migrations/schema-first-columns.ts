import type { PoolClient } from "pg"

export const SCHEMA_FIRST_NULLABLE_COLUMNS = {
  "126_doc_version_numbers": ["doc_versions", "version_number", "integer"],
  "128_task_start_date": ["tasks", "start_date", "timestamp with time zone"],
} as const

export async function assertSchemaFirstNullableColumn(
  client: PoolClient,
  schema: string,
  [table, column, type]: readonly [string, string, string],
) {
  const result = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3 AND data_type=$4 AND is_nullable='YES' AND column_default IS NULL AND is_generated='NEVER'",
    [schema, table, column, type],
  )
  if (result.rows.length !== 1) throw new Error(`Migration postcondition failed: ${table}.${column} must be a writable nullable ${type} without a default`)
}
