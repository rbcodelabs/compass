import type { PoolClient } from "pg"

export const AGENT_CONVERSATION_REVIEWS_MIGRATION = "109_agent_conversation_reviews"
export const AGENT_REVIEW_TABLE = "agent_conversation_reviews"

/** Columns 109 must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "conversation_id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "user_id", nullable: false },
  { column: "reviewed_at", nullable: false },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
]

export const AGENT_REVIEW_INDEXES = [
  // One row per (conversation, user): the upsert key, and what stops two tabs creating duplicates.
  { name: "idx_agent_conversation_reviews_conversation_user", columns: "conversation_id,user_id", unique: true },
  // The board read: "my reviews in this workspace".
  { name: "idx_agent_conversation_reviews_user_workspace", columns: "user_id,workspace_id", unique: false },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique index is what
 * keeps a user to one review row per conversation, so an async build that never finished (or a
 * drifted table) fails closed instead of letting concurrent marks create duplicates.
 */
export async function assertAgentConversationReviewsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, AGENT_REVIEW_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 109 postcondition failed: ${AGENT_REVIEW_TABLE}.${column} is missing or has the wrong nullability`)
    }
  }

  for (const expected of AGENT_REVIEW_INDEXES) {
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
      row.table_name !== AGENT_REVIEW_TABLE ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`Migration 109 postcondition failed: index ${expected.name} is missing, not ready, or has drifted`)
    }
  }
}
