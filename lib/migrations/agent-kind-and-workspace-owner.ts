import type { PoolClient } from "pg"

export const AGENT_KIND_AND_WORKSPACE_OWNER_MIGRATION = "098_agent_kind_and_workspace_owner"
export const AGENT_OWNER_WORKSPACE_INDEX = "agents_owner_workspace_id_idx"

/** Columns 098 adds to agents, with the data type information_schema must report. */
const ADDED_COLUMNS: { column: string; dataType: string }[] = [
  { column: "kind", dataType: "character varying" },
  { column: "owner_type", dataType: "character varying" },
  { column: "owner_workspace_id", dataType: "uuid" },
  { column: "instructions", dataType: "text" },
  { column: "model", dataType: "character varying" },
  { column: "invoke_policy", dataType: "character varying" },
]

/**
 * Postcondition run before the migration's completion receipt is written. Proves the six new
 * columns exist and are nullable, that owner_user_id really dropped NOT NULL (DSQL has not been
 * exercised for that statement from this repo, so a refusal must fail here rather than record
 * success), and that the owner_workspace_id index is valid and ready.
 */
export async function assertAgentKindAndWorkspaceOwnerMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
    "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agents'",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType } of ADDED_COLUMNS) {
    const row = actual.get(column)
    if (!row || row.is_nullable !== "YES" || row.data_type !== dataType) {
      throw new Error(`Migration 098 postcondition failed: agents.${column} must be a nullable ${dataType} column`)
    }
  }
  if (actual.get("owner_user_id")?.is_nullable !== "YES") {
    throw new Error("Migration 098 postcondition failed: agents.owner_user_id is missing or still NOT NULL")
  }

  const index = await client.query<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }>(
    `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, AGENT_OWNER_WORKSPACE_INDEX],
  )
  const row = index.rows[0]
  if (
    index.rows.length !== 1 ||
    !row.valid ||
    !row.ready ||
    row.unique ||
    row.table_name !== "agents" ||
    row.columns.join(",") !== "owner_workspace_id" ||
    row.predicate !== null
  ) {
    throw new Error(`Agent ownership migration index ${AGENT_OWNER_WORKSPACE_INDEX} is not ready or has drifted`)
  }
}
