import type { PoolClient } from "pg"

export const AGENT_MESSAGE_RUN_ID_MIGRATION = "129_agent_message_run_id"
export const AGENT_MESSAGE_RUN_ID_INDEX = "idx_agent_messages_run"

/**
 * Postcondition run before the migration's completion receipt is written.
 *
 * Why it exists: the migration is `ADD COLUMN IF NOT EXISTS` plus `CREATE INDEX ASYNC IF NOT EXISTS`. On Aurora DSQL the
 * index is built by a background job, and `IF NOT EXISTS` makes a same-named object with the wrong definition (or one
 * whose build failed) look like success. Without this check the runner could record a finished receipt for an index
 * that is absent, still building or drifted. Fails closed on any of those, and on a column that is not a bare nullable
 * uuid (a default or NOT NULL would break the "legacy rows stay NULL" spend contract in lib/agent-spend.ts).
 */
export async function assertAgentMessageRunIdMigration(client: PoolClient, schema: string) {
  const column = await client.query<{ data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
    "SELECT data_type, is_nullable, column_default, is_generated FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_messages' AND column_name='run_id'",
    [schema],
  )
  const col = column.rows[0]
  if (!col || col.data_type !== "uuid" || col.is_nullable !== "YES" || col.column_default !== null || col.is_generated !== "NEVER") {
    throw new Error("Migration 129 postcondition failed: agent_messages.run_id must be a writable nullable uuid without a default")
  }

  const index = await client.query<{
    valid: boolean
    ready: boolean
    unique: boolean
    table_name: string
    column_count: number
    columns: string[]
    predicate: string | null
    expression: string | null
  }>(
    `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,i.indnatts AS column_count,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expression
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, AGENT_MESSAGE_RUN_ID_INDEX],
  )
  const row = index.rows[0]
  if (index.rows.length !== 1) {
    throw new Error(`Migration 129 postcondition failed: index ${AGENT_MESSAGE_RUN_ID_INDEX} is missing`)
  }
  if (!row.valid || !row.ready) {
    throw new Error(`Migration 129 postcondition failed: index ${AGENT_MESSAGE_RUN_ID_INDEX} is not ready`)
  }
  if (row.unique || row.table_name !== "agent_messages" || row.column_count !== 1 || row.columns.join(",") !== "run_id" || row.predicate !== null || row.expression !== null) {
    throw new Error(`Migration 129 postcondition failed: index ${AGENT_MESSAGE_RUN_ID_INDEX} has drifted from agent_messages(run_id)`)
  }
}
