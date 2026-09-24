import type { PoolClient } from "pg";

export async function assertWorkspaceUpdatesMigration(
  client: PoolClient,
  schema: string,
) {
  const expected = [
    [
      "workspace_update_events_revision_key",
      "workspace_update_events",
      "workspace_id,revision",
    ],
    [
      "workspace_updates_read_state_user_key",
      "workspace_updates_read_state",
      "workspace_id,user_id",
    ],
  ];
  for (const [name, table, columns] of expected) {
    const result = await client.query<{
      valid: boolean;
      ready: boolean;
      unique: boolean;
      table_name: string;
      columns: string[];
      predicate: string | null;
      expression: string | null;
    }>(
      `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expression
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, name],
    );
    const index = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !index.valid ||
      !index.ready ||
      !index.unique ||
      index.table_name !== table ||
      index.columns.join(",") !== columns ||
      index.predicate !== null ||
      index.expression !== null
    )
      throw new Error(
        `Updates migration index ${name} is not ready or has drifted`,
      );
  }
}
