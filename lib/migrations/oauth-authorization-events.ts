import type { PoolClient } from "pg"

export const OAUTH_AUTHORIZATION_EVENT_COLUMNS = [
  "oauth_authorization_events.id",
  "oauth_authorization_events.event_type",
  "oauth_authorization_events.source",
  "oauth_authorization_events.authorization_code_id",
  "oauth_authorization_events.user_id",
  "oauth_authorization_events.client_id",
  "oauth_authorization_events.client_name_snapshot",
  "oauth_authorization_events.redirect_origin",
  "oauth_authorization_events.authorization_mode",
  "oauth_authorization_events.agent_id",
  "oauth_authorization_events.scope",
  "oauth_authorization_events.created_at",
] as const

export const OAUTH_AUTHORIZATION_EVENT_INDEXES = [
  "idx_oauth_authorization_events_code",
  "idx_oauth_authorization_events_user_created",
  "idx_oauth_authorization_events_client_created",
] as const

export async function assertOAuthAuthorizationEventsMigration(
  client: PoolClient,
  schema: string,
) {
  const columns = await client.query<{
    table_name: string
    column_name: string
    is_nullable: "YES" | "NO"
  }>(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'oauth_authorization_events'`,
    [schema],
  )
  const presentColumns = new Set(
    columns.rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
  )
  const missingColumns = OAUTH_AUTHORIZATION_EVENT_COLUMNS.filter(
    (column) => !presentColumns.has(column),
  )
  if (missingColumns.length > 0) {
    throw new Error(
      `Migration 058 postcondition failed: missing column(s) ${missingColumns.join(", ")}.`,
    )
  }

  const wronglyNullable = columns.rows.filter(
    ({ column_name, is_nullable }) => column_name !== "agent_id" && is_nullable !== "NO",
  )
  if (wronglyNullable.length > 0) {
    throw new Error(
      `Migration 058 postcondition failed: required column(s) nullable ${wronglyNullable.map(({ column_name }) => column_name).join(", ")}.`,
    )
  }

  const indexes = await client.query<{ name: string; valid: boolean; unique: boolean }>(
    `SELECT index_class.relname AS name,
            index_catalog.indisvalid AS valid,
            index_catalog.indisunique AS unique
       FROM pg_index index_catalog
       JOIN pg_class index_class ON index_class.oid = index_catalog.indexrelid
       JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = $1
        AND table_class.relname = 'oauth_authorization_events'
        AND index_class.relname = ANY($2::text[])`,
    [schema, [...OAUTH_AUTHORIZATION_EVENT_INDEXES]],
  )
  const validIndexes = new Set(indexes.rows.filter(({ valid }) => valid).map(({ name }) => name))
  const invalidIndexes = OAUTH_AUTHORIZATION_EVENT_INDEXES.filter(
    (index) => !validIndexes.has(index),
  )
  if (invalidIndexes.length > 0) {
    throw new Error(
      `Migration 058 postcondition failed: index(es) missing or not valid ${invalidIndexes.join(", ")}.`,
    )
  }

  const codeIndex = indexes.rows.find(({ name }) => name === "idx_oauth_authorization_events_code")
  if (!codeIndex?.unique) {
    throw new Error("Migration 058 postcondition failed: authorization-code index must be UNIQUE.")
  }
}
