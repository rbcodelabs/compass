import type { PoolClient } from "pg"

export const AGENT_RUN_ATTRIBUTION_MIGRATION = "100_agent_runs_agent_attribution"
export const AGENT_RUN_AGENT_INDEX = "agent_runs_agent_id_created_at_idx"
export const AGENT_RUN_INVOKER_INDEX = "agent_runs_invoked_by_user_id_idx"

const INDEXES: { name: string; columns: string }[] = [
  { name: AGENT_RUN_AGENT_INDEX, columns: "agent_id,created_at" },
  { name: AGENT_RUN_INVOKER_INDEX, columns: "invoked_by_user_id" },
]

/**
 * Postcondition for 100, run before its completion receipt is written. Proves both new columns exist
 * as nullable uuid columns and that both indexes are valid, ready, non-unique, non-partial and on the
 * intended columns (a half-built async index must not record success).
 */
export async function assertAgentRunAttributionMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
    "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_runs'",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const column of ["agent_id", "invoked_by_user_id"]) {
    const row = actual.get(column)
    if (!row || row.is_nullable !== "YES" || row.data_type !== "uuid") {
      throw new Error(`Migration 100 postcondition failed: agent_runs.${column} must be a nullable uuid column`)
    }
  }

  for (const { name, columns } of INDEXES) {
    const index = await client.query<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }>(
      `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
        pg_get_expr(i.indpred,i.indrelid) AS predicate
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      row.unique ||
      row.table_name !== "agent_runs" ||
      row.columns.join(",") !== columns ||
      row.predicate !== null
    ) {
      throw new Error(`Agent run attribution migration index ${name} is not ready or has drifted`)
    }
  }
}
