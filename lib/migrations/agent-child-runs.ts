import type { PoolClient } from "pg"

export const AGENT_CHILD_RUNS_MIGRATION = "120_agent_child_runs"
export const AGENT_CHILD_RUNS_TABLE = "agent_child_runs"

const EXPECTED_COLUMNS: { column: string; dataType: string; nullable: boolean }[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "conversation_id", dataType: "uuid", nullable: false },
  { column: "run_id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "native_agent_id", dataType: "character varying", nullable: false },
  { column: "parent_child_run_id", dataType: "uuid", nullable: true },
  { column: "parent_native_agent_id", dataType: "character varying", nullable: true },
  { column: "role", dataType: "character varying", nullable: false },
  { column: "description", dataType: "character varying", nullable: false },
  { column: "status", dataType: "character varying", nullable: false },
  { column: "current_activity", dataType: "character varying", nullable: true },
  { column: "step_count", dataType: "integer", nullable: false },
  { column: "steps_json", dataType: "text", nullable: true },
  { column: "result_summary", dataType: "text", nullable: true },
  { column: "started_at", dataType: "timestamp without time zone", nullable: false },
  { column: "finished_at", dataType: "timestamp without time zone", nullable: true },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

export const AGENT_CHILD_RUNS_INDEXES = [
  // Idempotency key per parent run + SDK tool_use id so event batch replays never duplicate rows.
  { name: "idx_agent_child_runs_run_native", columns: "run_id,native_agent_id", unique: true },
  // Chronological timeline read for one conversation's subagent tree.
  { name: "idx_agent_child_runs_conversation_started", columns: "conversation_id,started_at", unique: false },
  // Workspace-scoped board batch reads and workspace teardown.
  { name: "idx_agent_child_runs_workspace_conversation", columns: "workspace_id,conversation_id", unique: false },
] as const

/**
 * Postcondition run before 120's completion receipt: every column must exist with the expected data type
 * and nullability, and all three indexes must be valid, ready, and unpredicated.
 */
export async function assertAgentChildRunsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
    [schema, AGENT_CHILD_RUNS_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType, nullable } of EXPECTED_COLUMNS) {
    const row = actual.get(column)
    if (!row) {
      throw new Error(`${AGENT_CHILD_RUNS_MIGRATION}: column postcondition failed: ${AGENT_CHILD_RUNS_TABLE}.${column} missing`)
    }
    if (row.data_type !== dataType) {
      throw new Error(
        `${AGENT_CHILD_RUNS_MIGRATION}: type postcondition failed: ${AGENT_CHILD_RUNS_TABLE}.${column} is ${row.data_type}, expected ${dataType}`,
      )
    }
    if ((row.is_nullable === "YES") !== nullable) {
      throw new Error(
        `${AGENT_CHILD_RUNS_MIGRATION}: nullability postcondition failed: ${AGENT_CHILD_RUNS_TABLE}.${column} is_nullable=${row.is_nullable}`,
      )
    }
  }

  for (const expected of AGENT_CHILD_RUNS_INDEXES) {
    const index = await client.query<{
      valid: boolean
      ready: boolean
      unique: boolean
      table_name: string
      columns: string[]
      predicate: string | null
      expression: string | null
    }>(
      `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expression
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, expected.name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      row.unique !== expected.unique ||
      row.table_name !== AGENT_CHILD_RUNS_TABLE ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`${AGENT_CHILD_RUNS_MIGRATION}: index postcondition failed: ${expected.name} is missing, not ready, or has drifted`)
    }
  }
}
