import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 054_agent_access_requests.
 *
 * Mirrors assertAgentIdentityMigration / assertSharedFieldOptionSetsMigration:
 * the runner only writes a finished receipt once this passes, so a
 * half-applied schema stays visible as an unfinished attempt instead of
 * being recorded as done.
 */

export const AGENT_ACCESS_REQUEST_INDEXES = [
  "idx_agent_access_requests_agent_workspace_status",
  "idx_agent_access_requests_workspace_status",
] as const

const REQUIRED_COLUMNS = [
  "agent_access_requests.id",
  "agent_access_requests.agent_id",
  "agent_access_requests.workspace_id",
  "agent_access_requests.requested_access",
  "agent_access_requests.requested_by_user_id",
  "agent_access_requests.status",
  "agent_access_requests.decided_by_user_id",
  "agent_access_requests.decided_at",
  "agent_access_requests.created_at",
  "agent_access_requests.updated_at",
] as const

export async function assertAgentAccessRequestsMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name = $2",
    [schema, "agent_access_requests"],
  )
  const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`))
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column))
  if (missing.length > 0) {
    throw new Error(`Migration 054 postcondition failed: missing column(s) ${missing.join(", ")}.`)
  }

  const indexes = await client.query<{ name: string; valid: boolean }>(
    "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...AGENT_ACCESS_REQUEST_INDEXES]],
  )
  const unhealthy = AGENT_ACCESS_REQUEST_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 054 postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }
}
