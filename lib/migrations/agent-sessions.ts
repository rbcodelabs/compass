import type { PoolClient } from "pg"

/** Columns 080_agent_sessions must leave behind, with their nullability. */
const EXPECTED_COLUMNS = [
  "conversation_id",
  "workspace_id",
  "session_id",
  "blob_key",
  "through_message_id",
  "revision",
  "byte_size",
  "created_at",
  "updated_at",
] as const

/**
 * Postcondition run before the migration's completion receipt is written. A drifted
 * table (missing column, nullable column, or no primary key on conversation_id) fails
 * closed, so the receipt is never recorded for a half-built table.
 */
export async function assertAgentSessionsMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_sessions'",
    [schema],
  )
  const actual = new Map(columns.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const column of EXPECTED_COLUMNS) {
    if (actual.get(column) !== false) {
      throw new Error(`Migration 080 postcondition failed: agent_sessions.${column} is missing or nullable`)
    }
  }
  const pk = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
     WHERE tc.table_schema=$1 AND tc.table_name='agent_sessions' AND tc.constraint_type='PRIMARY KEY'`,
    [schema],
  )
  if (pk.rows.length !== 1 || pk.rows[0].column_name !== "conversation_id") {
    throw new Error("Migration 080 postcondition failed: agent_sessions must be keyed by conversation_id alone")
  }
}
