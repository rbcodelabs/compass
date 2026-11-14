import type { PoolClient } from "pg"

export const AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION = "122_agent_orchestrator_supervision"
export const AGENT_ORCHESTRATORS_TABLE = "agent_orchestrators"
export const AGENT_CONVERSATION_SUPERVISION_TABLE = "agent_conversation_supervision"

type ExpectedColumn = { column: string; dataType: string; nullable: boolean }

const ORCHESTRATOR_COLUMNS: readonly ExpectedColumn[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "user_id", dataType: "uuid", nullable: false },
  { column: "scope_type", dataType: "character varying", nullable: false },
  { column: "scope_key", dataType: "character varying", nullable: false },
  { column: "conversation_id", dataType: "uuid", nullable: true },
  { column: "agent_id", dataType: "uuid", nullable: true },
  { column: "enabled", dataType: "boolean", nullable: false },
  { column: "wake_on_activity", dataType: "boolean", nullable: false },
  { column: "heartbeat_enabled", dataType: "boolean", nullable: false },
  { column: "heartbeat_minutes", dataType: "integer", nullable: false },
  { column: "escalations_enabled", dataType: "boolean", nullable: false },
  { column: "last_heartbeat_at", dataType: "timestamp without time zone", nullable: true },
  { column: "last_escalation_state_json", dataType: "text", nullable: false },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

const SUPERVISION_COLUMNS: readonly ExpectedColumn[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "conversation_id", dataType: "uuid", nullable: false },
  { column: "supervisor_user_id", dataType: "uuid", nullable: false },
  { column: "manager_notes", dataType: "text", nullable: false },
  { column: "manager_notes_updated_at", dataType: "timestamp without time zone", nullable: true },
  { column: "manager_source_orchestrator_id", dataType: "uuid", nullable: true },
  { column: "proposed_reply_text", dataType: "text", nullable: true },
  { column: "proposed_reply_generated_at", dataType: "timestamp without time zone", nullable: true },
  { column: "proposed_reply_author_orchestrator_id", dataType: "uuid", nullable: true },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

export const AGENT_ORCHESTRATOR_SUPERVISION_INDEXES = [
  {
    table: AGENT_ORCHESTRATORS_TABLE,
    name: "agent_orchestrators_user_ws_scope_key",
    columns: "user_id,workspace_id,scope_type,scope_key",
    unique: true,
  },
  {
    table: AGENT_ORCHESTRATORS_TABLE,
    name: "idx_agent_orchestrators_workspace_user",
    columns: "workspace_id,user_id",
    unique: false,
  },
  {
    table: AGENT_ORCHESTRATORS_TABLE,
    name: "idx_agent_orchestrators_conversation",
    columns: "conversation_id",
    unique: false,
  },
  {
    table: AGENT_CONVERSATION_SUPERVISION_TABLE,
    name: "agent_conversation_supervision_conv_user_key",
    columns: "conversation_id,supervisor_user_id",
    unique: true,
  },
  {
    table: AGENT_CONVERSATION_SUPERVISION_TABLE,
    name: "idx_agent_conversation_supervision_ws_user",
    columns: "workspace_id,supervisor_user_id",
    unique: false,
  },
] as const

async function assertTableColumns(
  client: PoolClient,
  schema: string,
  tableName: string,
  expectedColumns: readonly ExpectedColumn[],
) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
    [schema, tableName],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType, nullable } of expectedColumns) {
    const row = actual.get(column)
    if (!row) {
      throw new Error(`${AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION}: column postcondition failed: ${tableName}.${column} missing`)
    }
    if (row.data_type !== dataType) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION}: type postcondition failed: ${tableName}.${column} is ${row.data_type}, expected ${dataType}`,
      )
    }
    if ((row.is_nullable === "YES") !== nullable) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION}: nullability postcondition failed: ${tableName}.${column} is_nullable=${row.is_nullable}`,
      )
    }
  }
}

/**
 * Postcondition run before 122's completion receipt: every column of both tables must exist with the expected
 * data type and nullability, and all five indexes must be valid, ready, and unpredicated.
 */
export async function assertAgentOrchestratorSupervisionMigration(client: PoolClient, schema: string) {
  await assertTableColumns(client, schema, AGENT_ORCHESTRATORS_TABLE, ORCHESTRATOR_COLUMNS)
  await assertTableColumns(client, schema, AGENT_CONVERSATION_SUPERVISION_TABLE, SUPERVISION_COLUMNS)

  for (const expected of AGENT_ORCHESTRATOR_SUPERVISION_INDEXES) {
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
      row.table_name !== expected.table ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(
        `${AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION}: index postcondition failed: ${expected.name} is missing, not ready, or has drifted`,
      )
    }
  }
}
