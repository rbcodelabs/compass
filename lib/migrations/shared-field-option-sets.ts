import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 053_shared_field_option_sets.
 *
 * Mirrors assertAgentIdentityMigration / assertPmInterviewPostconditions: the
 * runner only writes a finished receipt once this passes, so a half-applied
 * schema stays visible as an unfinished attempt instead of being recorded as
 * done. The nullable/no-default check on the new column is the load-bearing
 * one — it is what guarantees every pre-existing field definition keeps
 * behaving exactly as it did before (NULL = "uses its own local options").
 */

export const SHARED_FIELD_OPTION_SET_INDEXES = [
  "idx_shared_field_option_sets_workspace_name",
  "idx_custom_field_definitions_shared_option_set",
] as const

const REQUIRED_COLUMNS = [
  "shared_field_option_sets.id",
  "shared_field_option_sets.workspace_id",
  "shared_field_option_sets.name",
  "shared_field_option_sets.options",
  "shared_field_option_sets.created_at",
  "shared_field_option_sets.updated_at",
  "shared_field_option_sets.created_by_id",
  "shared_field_option_sets.updated_by_id",
  "shared_field_option_sets.source",
  "custom_field_definitions.shared_option_set_id",
] as const

type ColumnRow = {
  table_name: string
  column_name: string
  is_nullable: string
  column_default: string | null
}

export async function assertSharedFieldOptionSetsMigration(client: PoolClient, schema: string) {
  const columns = await client.query<ColumnRow>(
    "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["shared_field_option_sets", "custom_field_definitions"]],
  )
  const byName = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  const missing = REQUIRED_COLUMNS.filter((column) => !byName.has(column))
  if (missing.length > 0) {
    throw new Error(`Migration 053 postcondition failed: missing column(s) ${missing.join(", ")}.`)
  }

  // Additive and opt-in by construction: no backfill runs, so every existing
  // row has to be allowed to stay NULL.
  const optIn = byName.get("custom_field_definitions.shared_option_set_id")!
  if (optIn.is_nullable !== "YES" || optIn.column_default !== null) {
    throw new Error(
      "Migration 053 postcondition failed: custom_field_definitions.shared_option_set_id must be nullable with no default.",
    )
  }

  const indexes = await client.query<{ name: string; valid: boolean }>(
    "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...SHARED_FIELD_OPTION_SET_INDEXES]],
  )
  const unhealthy = SHARED_FIELD_OPTION_SET_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 053 postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }
}
