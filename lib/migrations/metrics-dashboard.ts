import type { PoolClient } from "pg"

export const METRICS_DASHBOARD_COLUMNS = ["dashboard_visible", "dashboard_col", "dashboard_row", "dashboard_sort_order"]

/**
 * Postcondition for 063_metrics_dashboard: the four layout columns exist on
 * metric_definitions (all nullable -- DSQL forbids a DEFAULT on ALTER TABLE
 * ADD COLUMN, see the migration file) and no pre-existing row was left NULL
 * by the migration's backfill UPDATE statements.
 */
export async function assertMetricsDashboardMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'metric_definitions' AND column_name = ANY($2::text[])",
    [schema, METRICS_DASHBOARD_COLUMNS]
  )
  for (const name of METRICS_DASHBOARD_COLUMNS) {
    const actual = columns.rows.find(row => row.column_name === name)
    if (!actual || actual.is_nullable !== "YES") throw new Error(`063_metrics_dashboard: column postcondition failed: metric_definitions.${name}`)
  }
  const unbackfilled = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}"."metric_definitions" WHERE dashboard_visible IS NULL OR dashboard_col IS NULL OR dashboard_row IS NULL OR dashboard_sort_order IS NULL`
  )
  if (unbackfilled.rows[0]?.count !== "0") throw new Error("063_metrics_dashboard: backfill postcondition failed: NULL layout values remain")
}
