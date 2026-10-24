import type { PoolClient } from "pg"

export const AGENT_SANDBOX_CLASS_MIGRATION = "110_agent_sandbox_class"
export const AGENT_RUNTIME_SNAPSHOTS_TABLE = "agent_runtime_snapshots"
export const AGENT_RUNTIME_SNAPSHOTS_CLASS_INDEX = "idx_agent_runtime_snapshots_class"

/** Columns 110 must leave behind, as table.column -> nullable. */
const EXPECTED_COLUMNS: { table: string; column: string; nullable: boolean }[] = [
  { table: "agents", column: "sandbox_class", nullable: true },
  { table: "workspaces", column: "agent_developer_sandbox_enabled", nullable: true },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "id", nullable: false },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "sandbox_class", nullable: false },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "snapshot_id", nullable: true },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "deps_fingerprint", nullable: true },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "base_snapshot_id", nullable: true },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "snapshot_built_at", nullable: true },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "created_at", nullable: false },
  { table: AGENT_RUNTIME_SNAPSHOTS_TABLE, column: "updated_at", nullable: false },
]

/**
 * Postcondition run before the migration's completion receipt is written. The unique index is what
 * keeps a sandbox class to a single snapshot row, so an async build that never finished (or a drifted
 * table) fails closed instead of letting two rebuilds record competing snapshots.
 */
export async function assertAgentSandboxClassMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2)",
    [schema, ["agents", "workspaces", AGENT_RUNTIME_SNAPSHOTS_TABLE]],
  )
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable === "YES"]))
  for (const { table, column, nullable } of EXPECTED_COLUMNS) {
    if (actual.get(`${table}.${column}`) !== nullable) {
      throw new Error(`Migration 110 postcondition failed: ${table}.${column} is missing or has the wrong nullability`)
    }
  }

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
    [schema, AGENT_RUNTIME_SNAPSHOTS_CLASS_INDEX],
  )
  const row = index.rows[0]
  if (
    index.rows.length !== 1 ||
    !row.valid ||
    !row.ready ||
    !row.unique ||
    row.table_name !== AGENT_RUNTIME_SNAPSHOTS_TABLE ||
    row.columns.join(",") !== "sandbox_class" ||
    row.predicate !== null ||
    row.expression !== null
  ) {
    throw new Error(`Migration 110 postcondition failed: index ${AGENT_RUNTIME_SNAPSHOTS_CLASS_INDEX} is missing, not ready, or has drifted`)
  }
}
