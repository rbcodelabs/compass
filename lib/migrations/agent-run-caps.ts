import type { PoolClient } from "pg"

export const AGENT_RUN_CAPS_MIGRATION = "102_agent_run_caps"

const ADDED_COLUMNS = ["max_concurrent_runs", "max_runs_per_day"] as const

/**
 * Postcondition for 102, run before its completion receipt is written. Proves both cap columns exist on agents as nullable
 * integers: nullable is the contract (NULL = the default cap), and a NOT NULL or wrongly typed column would make every
 * agent without an explicit cap fail to load.
 */
export async function assertAgentRunCapsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
    "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agents'",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const column of ADDED_COLUMNS) {
    const row = actual.get(column)
    if (!row || row.is_nullable !== "YES" || row.data_type !== "integer") {
      throw new Error(`Migration 102 postcondition failed: agents.${column} must be a nullable integer column`)
    }
  }
}
