import type { PoolClient } from "pg"

/** Columns 081_agent_web_searches must leave behind, with their nullability (true = nullable). */
const EXPECTED_COLUMNS: Record<string, boolean> = {
  credential_id: false,
  seq: false,
  user_id: false,
  workspace_id: false,
  conversation_id: true,
  query: false,
  status: false,
  result_count: false,
  result_urls: false,
  created_at: false,
  finished_at: true,
}

/**
 * Postcondition run before the migration's completion receipt is written. The
 * composite primary key is the per-turn budget, so a table without it would let a
 * turn exceed its cap: fail closed rather than record a receipt for a half-built table.
 */
export async function assertAgentWebSearchesMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_web_searches'",
    [schema],
  )
  const actual = new Map(columns.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const [column, nullable] of Object.entries(EXPECTED_COLUMNS)) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 081 postcondition failed: agent_web_searches.${column} is missing or has the wrong nullability`)
    }
  }
  const pk = await client.query<{ column_name: string; ordinal_position: number }>(
    `SELECT kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
     WHERE tc.table_schema=$1 AND tc.table_name='agent_web_searches' AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schema],
  )
  const key = pk.rows.map((row) => row.column_name).join(",")
  if (key !== "credential_id,seq") {
    throw new Error("Migration 081 postcondition failed: agent_web_searches must be keyed by (credential_id, seq)")
  }
}
