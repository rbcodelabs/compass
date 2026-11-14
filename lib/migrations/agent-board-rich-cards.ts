import type { PoolClient } from "pg"

export const AGENT_BOARD_RICH_CARDS_MIGRATION = "119_agent_board_rich_cards"

const EXPECTED_COLUMNS: { table: string; column: string; dataType: string }[] = [
  { table: "agent_conversations", column: "squad_id", dataType: "uuid" },
  { table: "agent_conversations", column: "summary", dataType: "character varying" },
  { table: "agent_conversations", column: "pr_url", dataType: "character varying" },
  { table: "agent_runs", column: "substatus", dataType: "character varying" },
  { table: "agent_runs", column: "current_activity", dataType: "character varying" },
]

/** Postcondition run before 119's completion receipt: every column must exist, carry the expected type, and be nullable. */
export async function assertAgentBoardRichCardsMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'agent_conversations' AND column_name IN ('squad_id', 'summary', 'pr_url')) OR (table_name = 'agent_runs' AND column_name IN ('substatus', 'current_activity')))",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  for (const { table, column, dataType } of EXPECTED_COLUMNS) {
    const key = `${table}.${column}`
    const row = actual.get(key)
    if (!row) throw new Error(`${AGENT_BOARD_RICH_CARDS_MIGRATION}: column postcondition failed: ${key} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${AGENT_BOARD_RICH_CARDS_MIGRATION}: type postcondition failed: ${key} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${AGENT_BOARD_RICH_CARDS_MIGRATION}: nullability postcondition failed: ${key} is NOT NULL`)
    }
  }
}
