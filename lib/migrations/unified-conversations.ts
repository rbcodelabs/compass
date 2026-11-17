import type { PoolClient } from "pg"

export const UNIFIED_CONVERSATIONS_MIGRATION = "125_unified_conversations"

const EXPECTED_COLUMNS: { table: string; column: string; dataType: string }[] = [
  { table: "agent_conversations", column: "target_type", dataType: "character varying" },
  { table: "agent_conversations", column: "target_id", dataType: "uuid" },
  { table: "agent_conversations", column: "visibility", dataType: "character varying" },
  { table: "agent_conversations", column: "status", dataType: "character varying" },
  { table: "agent_conversations", column: "agent_mode", dataType: "character varying" },
  { table: "agent_conversations", column: "source", dataType: "character varying" },
  { table: "agent_conversations", column: "resolved_at", dataType: "timestamp without time zone" },
  { table: "agent_conversations", column: "resolved_by_id", dataType: "uuid" },
  { table: "agent_messages", column: "author_name", dataType: "character varying" },
  { table: "agent_messages", column: "author_type", dataType: "character varying" },
  { table: "agent_messages", column: "message_kind", dataType: "character varying" },
  { table: "agent_messages", column: "edited_at", dataType: "timestamp without time zone" },
]

/** Postcondition run before 125's completion receipt: every column must exist, carry the expected type, and be nullable. */
export async function assertUnifiedConversationsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'agent_conversations' AND column_name IN ('target_type', 'target_id', 'visibility', 'status', 'agent_mode', 'source', 'resolved_at', 'resolved_by_id')) OR (table_name = 'agent_messages' AND column_name IN ('author_name', 'author_type', 'message_kind', 'edited_at')))",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  for (const { table, column, dataType } of EXPECTED_COLUMNS) {
    const key = `${table}.${column}`
    const row = actual.get(key)
    if (!row) throw new Error(`${UNIFIED_CONVERSATIONS_MIGRATION}: column postcondition failed: ${key} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${UNIFIED_CONVERSATIONS_MIGRATION}: type postcondition failed: ${key} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${UNIFIED_CONVERSATIONS_MIGRATION}: nullability postcondition failed: ${key} is NOT NULL`)
    }
  }
}
