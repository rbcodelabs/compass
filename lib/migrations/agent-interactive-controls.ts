import type { PoolClient } from "pg"

export const AGENT_INTERACTIVE_CONTROLS_MIGRATION = "121_agent_interactive_controls"
export const AGENT_INBOX_ITEMS_TABLE = "agent_inbox_items"
export const AGENT_SCHEDULED_WAKEUPS_TABLE = "agent_scheduled_wakeups"

type ExpectedColumn = { column: string; dataType: string; nullable: boolean }

const INBOX_ITEM_COLUMNS: readonly ExpectedColumn[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "conversation_id", dataType: "uuid", nullable: false },
  { column: "recipient_user_id", dataType: "uuid", nullable: true },
  { column: "source_conversation_id", dataType: "uuid", nullable: true },
  { column: "run_id", dataType: "uuid", nullable: true },
  { column: "native_tool_use_id", dataType: "character varying", nullable: true },
  { column: "kind", dataType: "character varying", nullable: false },
  { column: "header", dataType: "character varying", nullable: true },
  { column: "question", dataType: "text", nullable: false },
  { column: "options_json", dataType: "text", nullable: true },
  { column: "multi_select", dataType: "boolean", nullable: false },
  { column: "allow_other", dataType: "boolean", nullable: false },
  { column: "status", dataType: "character varying", nullable: false },
  { column: "answer_text", dataType: "text", nullable: true },
  { column: "resolved_by_user_id", dataType: "uuid", nullable: true },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "resolved_at", dataType: "timestamp without time zone", nullable: true },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

const SCHEDULED_WAKEUP_COLUMNS: readonly ExpectedColumn[] = [
  { column: "id", dataType: "uuid", nullable: false },
  { column: "workspace_id", dataType: "uuid", nullable: false },
  { column: "conversation_id", dataType: "uuid", nullable: false },
  { column: "user_id", dataType: "uuid", nullable: false },
  { column: "agent_id", dataType: "uuid", nullable: true },
  { column: "source_run_id", dataType: "uuid", nullable: true },
  { column: "fire_at", dataType: "timestamp without time zone", nullable: false },
  { column: "delay_seconds", dataType: "integer", nullable: false },
  { column: "reason", dataType: "character varying", nullable: true },
  { column: "prompt", dataType: "text", nullable: false },
  { column: "status", dataType: "character varying", nullable: false },
  { column: "fired_run_id", dataType: "uuid", nullable: true },
  { column: "failure_reason", dataType: "character varying", nullable: true },
  { column: "created_at", dataType: "timestamp without time zone", nullable: false },
  { column: "fired_at", dataType: "timestamp without time zone", nullable: true },
  { column: "canceled_at", dataType: "timestamp without time zone", nullable: true },
  { column: "updated_at", dataType: "timestamp without time zone", nullable: false },
]

export const AGENT_INTERACTIVE_CONTROLS_INDEXES = [
  {
    table: AGENT_INBOX_ITEMS_TABLE,
    name: "idx_agent_inbox_items_conversation_status",
    columns: "conversation_id,status,created_at",
    unique: false,
  },
  {
    table: AGENT_INBOX_ITEMS_TABLE,
    name: "idx_agent_inbox_items_workspace_recipient",
    columns: "workspace_id,recipient_user_id,status",
    unique: false,
  },
  {
    table: AGENT_INBOX_ITEMS_TABLE,
    name: "idx_agent_inbox_items_run_status",
    columns: "run_id,status",
    unique: false,
  },
  {
    table: AGENT_SCHEDULED_WAKEUPS_TABLE,
    name: "idx_agent_scheduled_wakeups_status_fire_at",
    columns: "status,fire_at",
    unique: false,
  },
  {
    table: AGENT_SCHEDULED_WAKEUPS_TABLE,
    name: "idx_agent_scheduled_wakeups_conversation_status",
    columns: "conversation_id,status,fire_at",
    unique: false,
  },
  {
    table: AGENT_SCHEDULED_WAKEUPS_TABLE,
    name: "idx_agent_scheduled_wakeups_workspace_status",
    columns: "workspace_id,status",
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
      throw new Error(`${AGENT_INTERACTIVE_CONTROLS_MIGRATION}: column postcondition failed: ${tableName}.${column} missing`)
    }
    if (row.data_type !== dataType) {
      throw new Error(
        `${AGENT_INTERACTIVE_CONTROLS_MIGRATION}: type postcondition failed: ${tableName}.${column} is ${row.data_type}, expected ${dataType}`,
      )
    }
    if ((row.is_nullable === "YES") !== nullable) {
      throw new Error(
        `${AGENT_INTERACTIVE_CONTROLS_MIGRATION}: nullability postcondition failed: ${tableName}.${column} is_nullable=${row.is_nullable}`,
      )
    }
  }
}

/**
 * Postcondition run before 121's completion receipt: every column of both tables must exist with the expected
 * data type and nullability, and all six indexes must be valid, ready, and unpredicated.
 */
export async function assertAgentInteractiveControlsMigration(client: PoolClient, schema: string) {
  await assertTableColumns(client, schema, AGENT_INBOX_ITEMS_TABLE, INBOX_ITEM_COLUMNS)
  await assertTableColumns(client, schema, AGENT_SCHEDULED_WAKEUPS_TABLE, SCHEDULED_WAKEUP_COLUMNS)

  for (const expected of AGENT_INTERACTIVE_CONTROLS_INDEXES) {
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
        `${AGENT_INTERACTIVE_CONTROLS_MIGRATION}: index postcondition failed: ${expected.name} is missing, not ready, or has drifted`,
      )
    }
  }
}
