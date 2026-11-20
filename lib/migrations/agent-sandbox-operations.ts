import type { PoolClient } from "pg"

export const AGENT_SANDBOX_OPERATIONS_MIGRATION = "130_agent_sandbox_operations"

type Column = { column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }

async function assertTable(
  client: PoolClient,
  schema: string,
  table: string,
  primaryKey: string,
  expected: Record<string, [type: string, nullable: boolean]>,
) {
  const columns = await client.query<Column>(
    "SELECT column_name, data_type, is_nullable, column_default, is_generated FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, table],
  )
  const shape = new Map(columns.rows.map((column) => [column.column_name, column]))
  for (const [name, [type, nullable]] of Object.entries(expected)) {
    const column = shape.get(name)
    if (!column || column.data_type !== type || column.is_nullable !== (nullable ? "YES" : "NO") || column.column_default !== null || column.is_generated !== "NEVER") {
      throw new Error(`Migration 130 postcondition failed: ${table}.${name} has drifted or is missing`)
    }
  }
  for (const column of columns.rows) {
    if (!Object.hasOwn(expected, column.column_name) && column.is_nullable === "NO" && column.column_default === null && column.is_generated === "NEVER") {
      throw new Error(`Migration 130 postcondition failed: unexpected required column ${table}.${column.column_name}`)
    }
  }
  const key = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
       AND kcu.table_name=tc.table_name
     WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schema, table],
  )
  if (key.rows.length !== 1 || key.rows[0].column_name !== primaryKey) {
    throw new Error(`Migration 130 postcondition failed: ${table} requires a primary key on ${primaryKey}`)
  }
}

export async function assertAgentSandboxOperationsMigration(client: PoolClient, schema: string) {
  await assertTable(client, schema, "agent_sandbox_operations", "conversation_id", {
    conversation_id: ["uuid", false],
    run_id: ["uuid", false],
    sandbox_name: ["text", false],
    token: ["uuid", false],
    phase: ["text", false],
    provider_session_id: ["text", true],
    retry_at: ["timestamp with time zone", true],
  })
  await assertTable(client, schema, "agent_sandbox_generations", "sandbox_name", {
    sandbox_name: ["text", false],
    conversation_id: ["uuid", false],
    run_id: ["uuid", false],
  })
  const latch = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_conversations' AND column_name='sandbox_coordination_token' AND data_type='uuid' AND is_nullable='YES' AND column_default IS NULL AND is_generated='NEVER'",
    [schema],
  )
  if (latch.rows.length !== 1) throw new Error("Migration 130 postcondition failed: conversation coordination token has drifted or is missing")
}
