import type { PoolClient } from "pg"
import { withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

export const SAVED_VIEWS_SURFACE_MIGRATION = "100_saved_views_surface"
export const SAVED_VIEWS_SURFACE_INDEX = {
  name: "idx_roadmap_views_org_surface_kind",
  table: "roadmap_views",
  columns: "organization_id,workspace_id,surface",
} as const

/** DSQL caps a write transaction at 3,000 modified rows; stay far below it. */
export const SAVED_VIEWS_SURFACE_BACKFILL_BATCH_SIZE = 500

type Sleep = (ms: number) => Promise<void>

/**
 * Data half of 100: stamps `surface` on legacy rows. A row with no workspace is the org-level roadmap, any other
 * legacy row is a workspace roadmap (the only surfaces that existed before this migration). Idempotent and
 * resumable: only rows still NULL are touched, each batch is its own short statement.
 */
export async function backfillSavedViewsSurface(client: PoolClient, schema: string, log: string[] = [], sleep?: Sleep): Promise<number> {
  let total = 0
  while (true) {
    const batch = await client.query<{ id: string }>(
      `SELECT id FROM "${schema}"."roadmap_views" WHERE surface IS NULL LIMIT $1`,
      [SAVED_VIEWS_SURFACE_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) break
    const ids = batch.rows.map((row) => row.id)
    const result = await withOccRetry(
      () => client.query(
        `UPDATE "${schema}"."roadmap_views"
         SET surface = CASE WHEN workspace_id IS NULL THEN 'ROADMAP_ORG' ELSE 'ROADMAP_WORKSPACE' END
         WHERE id = ANY($1::uuid[]) AND surface IS NULL`,
        [ids],
      ),
      sleep,
    )
    total += result.rowCount ?? 0
  }
  log.push(`  ✓ backfilled ${total} roadmap_views.surface rows`)
  return total
}

/**
 * Postcondition run before the completion receipt: the column exists and is a nullable varchar, the async index is
 * valid and ready, and no legacy NULL surface is left behind. Fails closed, so a half-built index or an unfinished
 * backfill never gets a receipt (re-POST resumes).
 */
export async function assertSavedViewsSurfaceMigration(client: PoolClient, schema: string) {
  const column = await client.query<{ is_nullable: string; data_type: string }>(
    "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='surface'",
    [schema, SAVED_VIEWS_SURFACE_INDEX.table],
  )
  if (column.rows.length !== 1 || column.rows[0].is_nullable !== "YES" || column.rows[0].data_type !== "character varying") {
    throw new Error("Migration 100 postcondition failed: roadmap_views.surface must be a nullable varchar column")
  }

  const { name, table, columns } = SAVED_VIEWS_SURFACE_INDEX
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
    [schema, name],
  )
  const row = index.rows[0]
  if (
    index.rows.length !== 1 ||
    !row.valid ||
    !row.ready ||
    row.unique ||
    row.table_name !== table ||
    row.columns.join(",") !== columns ||
    row.predicate !== null ||
    row.expression !== null
  ) {
    throw new Error(`Saved views migration index ${name} is not ready or has drifted`)
  }

  const remaining = await client.query<{ remaining: string }>(
    `SELECT COUNT(*)::bigint AS remaining FROM "${schema}"."roadmap_views" WHERE surface IS NULL`,
  )
  if (Number(remaining.rows[0]?.remaining ?? 0) > 0) {
    throw new Error(`Migration 100 postcondition failed: ${remaining.rows[0].remaining} roadmap_views rows still have a NULL surface; POST again to resume`)
  }
}
