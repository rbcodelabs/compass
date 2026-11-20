import type { PoolClient } from "pg"

export const AGENT_SANDBOX_OPERATIONS_MIGRATION = "130_agent_sandbox_operations"

export async function assertAgentSandboxOperationsMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_sandbox_operations'",
    [schema],
  )
  const shape = new Map(columns.rows.map(({ column_name, data_type, is_nullable, column_default }) =>
    [column_name, [data_type, is_nullable, column_default]]))
  const expected = {
    conversation_id: ["uuid", "NO", null],
    run_id: ["uuid", "NO", null],
    sandbox_name: ["text", "NO", null],
    token: ["uuid", "NO", null],
    phase: ["text", "NO", null],
    retry_at: ["timestamp with time zone", "YES", null],
  }
  for (const [name, spec] of Object.entries(expected)) {
    if (JSON.stringify(shape.get(name)) !== JSON.stringify(spec)) {
      throw new Error(`Migration 130 postcondition failed: agent_sandbox_operations.${name} has drifted or is missing`)
    }
  }

  const latch = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_conversations' AND column_name='sandbox_coordination_token' AND data_type='uuid' AND is_nullable='YES' AND column_default IS NULL",
    [schema],
  )
  if (latch.rows.length !== 1) throw new Error("Migration 130 postcondition failed: conversation coordination token has drifted or is missing")

  const key = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
       AND kcu.table_name=tc.table_name
     WHERE tc.table_schema=$1 AND tc.table_name='agent_sandbox_operations' AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schema],
  )
  if (key.rows.length !== 1 || key.rows[0].column_name !== "conversation_id") {
    throw new Error("Migration 130 postcondition failed: expected a primary key on conversation_id")
  }
}
