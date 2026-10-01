import type { PoolClient } from "pg"

/** Tables and columns 068_follows_notifications must leave behind. */
const EXPECTED_TABLES: Record<string, { column: string; nullable: boolean }[]> = {
  follows: [
    { column: "id", nullable: false },
    { column: "workspace_id", nullable: false },
    { column: "user_id", nullable: false },
    { column: "subject_type", nullable: false },
    { column: "subject_id", nullable: false },
    { column: "state", nullable: false },
    { column: "source", nullable: false },
    { column: "created_at", nullable: false },
    { column: "updated_at", nullable: false },
  ],
  notifications: [
    { column: "id", nullable: false },
    { column: "workspace_id", nullable: false },
    { column: "recipient_user_id", nullable: false },
    { column: "subject_type", nullable: false },
    { column: "subject_id", nullable: false },
    { column: "kind", nullable: false },
    { column: "actor_type", nullable: false },
    // Null for EXTERNAL and SYSTEM actors; must stay nullable.
    { column: "actor_id", nullable: true },
    { column: "payload", nullable: false },
    // The dedupe key is what makes a replayed emit harmless.
    { column: "dedupe_key", nullable: false },
    // Null means unread.
    { column: "read_at", nullable: true },
    { column: "created_at", nullable: false },
  ],
}

export const FOLLOWS_NOTIFICATIONS_INDEXES = [
  { name: "idx_follows_user_subject", table: "follows", columns: "user_id,subject_type,subject_id", unique: true },
  { name: "idx_follows_subject", table: "follows", columns: "subject_type,subject_id", unique: false },
  { name: "idx_follows_workspace_user", table: "follows", columns: "workspace_id,user_id", unique: false },
  { name: "idx_notifications_recipient_dedupe", table: "notifications", columns: "recipient_user_id,dedupe_key", unique: true },
  { name: "idx_notifications_inbox", table: "notifications", columns: "workspace_id,recipient_user_id,created_at", unique: false },
] as const

/**
 * Postcondition run before the migration's completion receipt is written:
 * every column has the expected nullability and every index is valid, ready,
 * has the expected shape and is not partial or expression-based. An async index
 * that never finished, or a drifted table, fails closed instead of enabling the
 * feature on a schema that cannot enforce its uniqueness guarantees.
 */
export async function assertFollowsNotificationsMigration(client: PoolClient, schema: string) {
  for (const [table, columns] of Object.entries(EXPECTED_TABLES)) {
    const result = await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
      [schema, table],
    )
    const actual = new Map(result.rows.map((row) => [row.column_name, row.is_nullable === "YES"]))
    for (const { column, nullable } of columns) {
      if (actual.get(column) !== nullable) {
        throw new Error(`Migration 068 postcondition failed: ${table}.${column} is missing or has the wrong nullability`)
      }
    }
  }
  for (const { name, table, columns, unique } of FOLLOWS_NOTIFICATIONS_INDEXES) {
    const result = await client.query<{
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
      [schema, name],
    )
    const index = result.rows[0]
    if (
      result.rows.length !== 1 ||
      !index.valid ||
      !index.ready ||
      index.unique !== unique ||
      index.table_name !== table ||
      index.columns.join(",") !== columns ||
      index.predicate !== null ||
      index.expression !== null
    ) {
      throw new Error(`Follows/notifications migration index ${name} is not ready or has drifted`)
    }
  }
}
