import type { PoolClient } from "pg"

type ExpectedTable = {
  table: string
  columns: { column: string; nullable: boolean }[]
}

const c = (column: string, nullable = false) => ({ column, nullable })

/** Tables 082_artifact_external_share must leave behind, with column nullability. */
const EXPECTED_TABLES: ExpectedTable[] = [
  {
    table: "artifact_shares",
    columns: [
      c("id"), c("artifact_id"), c("workspace_id"), c("token_hash"), c("password_hash"),
      c("password_changed_at"), c("comments_enabled"), c("enabled_at"), c("revoked_at", true),
      c("failed_attempts"), c("failed_window_at", true), c("created_by_id"), c("created_at"), c("updated_at"),
    ],
  },
  {
    table: "artifact_share_sessions",
    columns: [c("id"), c("share_id"), c("artifact_id"), c("token_hash"), c("expires_at"), c("created_at")],
  },
  {
    table: "artifact_share_commenters",
    columns: [c("id"), c("share_id"), c("artifact_id"), c("portal_account_id"), c("token_hash"), c("expires_at"), c("created_at")],
  },
  {
    table: "artifact_share_events",
    columns: [c("id"), c("share_id"), c("artifact_id"), c("workspace_id"), c("event_type"), c("actor_id"), c("created_at")],
  },
]

export const ARTIFACT_SHARE_INDEXES = [
  { name: "idx_artifact_shares_artifact", table: "artifact_shares", columns: "artifact_id", unique: true },
  { name: "idx_artifact_shares_token_hash", table: "artifact_shares", columns: "token_hash", unique: true },
  { name: "idx_artifact_share_sessions_token_hash", table: "artifact_share_sessions", columns: "token_hash", unique: true },
  { name: "idx_artifact_share_sessions_share", table: "artifact_share_sessions", columns: "share_id", unique: false },
  { name: "idx_artifact_share_commenters_token_hash", table: "artifact_share_commenters", columns: "token_hash", unique: true },
  { name: "idx_artifact_share_commenters_share", table: "artifact_share_commenters", columns: "share_id", unique: false },
  { name: "idx_artifact_share_events_artifact_created", table: "artifact_share_events", columns: "artifact_id,created_at", unique: false },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique
 * indexes are what keep a link token and an artifact to one share each, so an async build
 * that never finished (or a drifted table) fails closed rather than allowing duplicates.
 */
export async function assertArtifactExternalShareMigration(client: PoolClient, schema: string) {
  for (const { table, columns } of EXPECTED_TABLES) {
    const result = await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
      [schema, table],
    )
    const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
    for (const { column, nullable } of columns) {
      if (actual.get(column) !== nullable) {
        throw new Error(`Migration 082 postcondition failed: ${table}.${column} is missing or has the wrong nullability`)
      }
    }
  }

  for (const expected of ARTIFACT_SHARE_INDEXES) {
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
      throw new Error(`Artifact external share migration index ${expected.name} is not ready or has drifted`)
    }
  }
}
