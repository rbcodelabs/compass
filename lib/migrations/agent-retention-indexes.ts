import type { PoolClient } from "pg"

export const AGENT_RETENTION_INDEXES_MIGRATION = "104_agent_retention_indexes"

const EXPECTED_INDEXES = ["idx_agent_run_events_created_at", "idx_agent_messages_created_at"] as const

/**
 * Postcondition run before the receipt is written: both indexes exist and are valid (DSQL builds them
 * asynchronously, so an index that is present but still building must not count as done).
 */
export async function assertAgentRetentionIndexesMigration(client: PoolClient, schema: string) {
  const { rows } = await client.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`,
    [schema, [...EXPECTED_INDEXES]],
  )
  const validity = new Map(rows.map((row) => [row.name, row.valid]))
  const missing = EXPECTED_INDEXES.filter((name) => validity.get(name) !== true)
  if (missing.length) {
    throw new Error(`Migration 104 postcondition failed: indexes missing or not ACTIVE: ${missing.join(", ")}`)
  }
}
