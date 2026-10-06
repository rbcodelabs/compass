import type { PoolClient } from "pg"

/** Columns 082_agent_conversation_participants must leave behind, with their nullability. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "conversation_id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "user_id", nullable: false },
  { column: "role", nullable: false },
  { column: "added_by_user_id", nullable: false },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
  // NULL = active participant; set = removed or left.
  { column: "removed_at", nullable: true },
]

export const AGENT_PARTICIPANT_TABLE = "agent_conversation_participants"

export const AGENT_PARTICIPANT_INDEXES = [
  // One row per (conversation, user). Re-inviting a removed user reuses the row.
  { name: "idx_agent_conversation_participants_conversation_user", columns: "conversation_id,user_id", unique: true },
  // The rail list: "conversations I participate in, in this workspace".
  { name: "idx_agent_conversation_participants_user_workspace", columns: "user_id,workspace_id", unique: false },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique
 * index is what keeps a user to one participant row per conversation, so an async build
 * that never finished (or a drifted table) fails closed instead of letting concurrent
 * invites create duplicates. Also checks the nullable agent_messages.author_user_id.
 */
export async function assertAgentConversationParticipantsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, AGENT_PARTICIPANT_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(column) !== nullable) {
      throw new Error(`Migration 082 postcondition failed: ${AGENT_PARTICIPANT_TABLE}.${column} is missing or has the wrong nullability`)
    }
  }

  const author = await client.query<{ is_nullable: string; data_type: string }>(
    "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_messages' AND column_name='author_user_id'",
    [schema],
  )
  if (author.rows.length !== 1 || author.rows[0].is_nullable !== "YES" || author.rows[0].data_type !== "uuid") {
    throw new Error("Migration 082 postcondition failed: agent_messages.author_user_id must be a nullable uuid column")
  }

  for (const expected of AGENT_PARTICIPANT_INDEXES) {
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
      row.table_name !== AGENT_PARTICIPANT_TABLE ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`Agent conversation participants migration index ${expected.name} is not ready or has drifted`)
    }
  }
}
