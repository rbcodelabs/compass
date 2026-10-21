import type { PoolClient } from "pg"

export const AGENT_DEFAULT_SELECTION_MIGRATION = "101_agent_default_selection"

type TableSpec = { table: string; columns: { column: string; nullable: boolean; type: string }[]; index: { name: string; columns: string } }

const TABLES: TableSpec[] = [
  {
    table: "workspace_default_agents",
    columns: [
      { column: "id", nullable: false, type: "uuid" },
      { column: "workspace_id", nullable: false, type: "uuid" },
      { column: "agent_id", nullable: false, type: "uuid" },
      { column: "set_by_user_id", nullable: true, type: "uuid" },
      { column: "created_at", nullable: false, type: "timestamp without time zone" },
      { column: "updated_at", nullable: false, type: "timestamp without time zone" },
    ],
    index: { name: "workspace_default_agents_workspace_id_key", columns: "workspace_id" },
  },
  {
    table: "user_default_agents",
    columns: [
      { column: "id", nullable: false, type: "uuid" },
      { column: "user_id", nullable: false, type: "uuid" },
      { column: "workspace_id", nullable: false, type: "uuid" },
      { column: "agent_id", nullable: false, type: "uuid" },
      { column: "created_at", nullable: false, type: "timestamp without time zone" },
      { column: "updated_at", nullable: false, type: "timestamp without time zone" },
    ],
    index: { name: "user_default_agents_user_id_workspace_id_key", columns: "user_id,workspace_id" },
  },
]

/**
 * Postcondition for 101, run before its completion receipt is written. Proves both tables have exactly the intended
 * columns (types and nullability) and that each unique index is valid, ready, unique, non-partial and on the intended
 * columns: the unique index is the only thing that keeps a workspace (or a user within a workspace) to one default, so
 * a half-built async index must not record success.
 */
export async function assertAgentDefaultSelectionMigration(client: PoolClient, schema: string) {
  for (const spec of TABLES) {
    const result = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
      [schema, spec.table],
    )
    const actual = new Map(result.rows.map((row) => [row.column_name, row]))
    for (const { column, nullable, type } of spec.columns) {
      const row = actual.get(column)
      if (!row || (row.is_nullable === "YES") !== nullable || row.data_type !== type) {
        throw new Error(`Migration 101 postcondition failed: ${spec.table}.${column} is missing or has the wrong type or nullability`)
      }
    }

    const index = await client.query<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }>(
      `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
        pg_get_expr(i.indpred,i.indrelid) AS predicate
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, spec.index.name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      !row.unique ||
      row.table_name !== spec.table ||
      row.columns.join(",") !== spec.index.columns ||
      row.predicate !== null
    ) {
      throw new Error(`Agent default selection migration index ${spec.index.name} is not ready or has drifted`)
    }
  }
}
