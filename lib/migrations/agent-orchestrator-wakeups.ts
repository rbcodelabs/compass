import type { PoolClient } from "pg"

export const AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION = "123_agent_orchestrator_wakeups"
export const AGENT_ORCHESTRATOR_WAKEUPS_TABLE = "agent_orchestrator_wakeups"

type ExpectedColumn = { column: string; dataType: string; nullable: boolean }

const WAKEUP_COLUMNS: readonly ExpectedColumn[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "orchestrator_id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "target_conversation_id", dataType: "uuid", nullable: false },
  { column: "event_status", dataType: "character varying", nullable: false },
  { column: "target_updated_at_iso", dataType: "character varying", nullable: false },
  { column: "quiet_until", dataType: "timestamp without time zone", nullable: false },
  { column: "flush_after", dataType: "timestamp without time zone", nullable: true },
  { column: "generation", dataType: "integer", nullable: false },
  { column: "busy_retries", dataType: "integer", nullable: false },
  { column: "state", dataType: "character varying", nullable: false },
  { column: "dispatched_run_id", dataType: "uuid", nullable: true },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

export const AGENT_ORCHESTRATOR_WAKEUPS_INDEXES = [
  {
    table: AGENT_ORCHESTRATOR_WAKEUPS_TABLE,
    name: "agent_orchestrator_wakeups_orch_target_key",
    columns: "orchestrator_id,target_conversation_id",
    unique: true,
  },
  {
    table: AGENT_ORCHESTRATOR_WAKEUPS_TABLE,
    name: "idx_agent_orchestrator_wakeups_state_quiet",
    columns: "state,quiet_until",
    unique: false,
  },
  {
    table: AGENT_ORCHESTRATOR_WAKEUPS_TABLE,
    name: "idx_agent_orchestrator_wakeups_state_flush",
    columns: "state,flush_after",
    unique: false,
  },
  {
    table: AGENT_ORCHESTRATOR_WAKEUPS_TABLE,
    name: "idx_agent_orchestrator_wakeups_workspace_orch",
    columns: "workspace_id,orchestrator_id",
    unique: false,
  },
] as const

export async function assertAgentOrchestratorWakeupsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
    [schema, AGENT_ORCHESTRATOR_WAKEUPS_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType, nullable } of WAKEUP_COLUMNS) {
    const row = actual.get(column)
    if (!row) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION}: column postcondition failed: ${AGENT_ORCHESTRATOR_WAKEUPS_TABLE}.${column} missing`,
      )
    }
    if (row.data_type !== dataType) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION}: type postcondition failed: ${AGENT_ORCHESTRATOR_WAKEUPS_TABLE}.${column} is ${row.data_type}`,
      )
    }
    if ((row.is_nullable === "YES") !== nullable) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION}: nullability postcondition failed: ${AGENT_ORCHESTRATOR_WAKEUPS_TABLE}.${column} is_nullable=${row.is_nullable}`,
      )
    }
  }

  for (const idx of AGENT_ORCHESTRATOR_WAKEUPS_INDEXES) {
    const indexResult = await client.query<{
      valid: boolean
      ready: boolean
      unique: boolean
      table_name: string
      columns: string[]
      predicate: string | null
      expression: string | null
    }>(
      `SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique,
              t.relname AS table_name,
              ARRAY(
                SELECT a.attname::text
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                WHERE k.ord <= i.indnkeyatts
                ORDER BY k.ord
              ) AS columns,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              pg_get_expr(i.indexprs, i.indrelid) AS expression
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, idx.name],
    )
    const row = indexResult.rows[0]
    const columns = Array.isArray(row?.columns) ? row.columns.join(",") : ""
    if (
      !row?.valid ||
      !row?.ready ||
      row.unique !== idx.unique ||
      row.table_name !== idx.table ||
      columns !== idx.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`${AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION}: index postcondition failed for ${idx.name}`)
    }
  }
}
