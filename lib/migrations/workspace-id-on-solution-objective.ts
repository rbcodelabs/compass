import type { PoolClient } from "pg"

export const WORKSPACE_ID_MIGRATION = "068_workspace_id_on_solution_objective"

/**
 * DSQL caps a write transaction at 3,000 modified rows, and each row also
 * maintains the new workspace_id index. 500 keeps well inside that.
 */
export const WORKSPACE_ID_BACKFILL_BATCH_SIZE = 500

type Target = {
  table: "solutions" | "objectives"
  parentTable: "opportunities" | "okr_cycles"
  parentKey: "opportunity_id" | "cycle_id"
  indexName: string
}

const TARGETS: readonly Target[] = [
  { table: "solutions", parentTable: "opportunities", parentKey: "opportunity_id", indexName: "idx_solutions_workspace_id" },
  { table: "objectives", parentTable: "okr_cycles", parentKey: "cycle_id", indexName: "idx_objectives_workspace_id" },
]

/**
 * Fills workspace_id from the parent row in bounded batches. Idempotent and
 * resumable: only rows still NULL are touched, each batch is its own
 * transaction, and a rerun after a crash simply continues. A row whose parent
 * is missing never matches the join and is left NULL for the postcondition to
 * report, so the loop always terminates.
 */
export async function backfillWorkspaceIdOnSolutionObjective(client: PoolClient, schema: string, log: string[]) {
  for (const target of TARGETS) {
    let total = 0
    while (true) {
      const result = await client.query(
        `WITH batch AS (
           SELECT child.id, parent.workspace_id
           FROM "${schema}"."${target.table}" AS child
           JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
           WHERE child.workspace_id IS NULL
           LIMIT $1
         )
         UPDATE "${schema}"."${target.table}" AS target
         SET workspace_id = batch.workspace_id
         FROM batch
         WHERE target.id = batch.id`,
        [WORKSPACE_ID_BACKFILL_BATCH_SIZE],
      )
      const updated = result.rowCount ?? 0
      total += updated
      if (updated === 0) break
    }
    log.push(`  ✓ backfilled ${total} ${target.table}.workspace_id rows`)
  }
}

/**
 * Postconditions, all of which must hold before the receipt is recorded:
 *   1. the column exists on both tables and the index is present and valid;
 *   2. no row has a NULL workspace_id (an orphan whose parent is gone counts);
 *   3. every row's workspace_id equals its parent's workspace_id.
 */
export async function assertWorkspaceIdOnSolutionObjective(client: PoolClient, schema: string) {
  for (const target of TARGETS) {
    const column = await client.query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'workspace_id'",
      [schema, target.table],
    )
    if (column.rows.length !== 1) throw new Error(`${WORKSPACE_ID_MIGRATION}: column postcondition failed: ${target.table}.workspace_id missing`)

    const index = await client.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, target.indexName],
    )
    if (index.rows.length !== 1 || index.rows[0].indisvalid !== true) {
      throw new Error(`${WORKSPACE_ID_MIGRATION}: index postcondition failed: ${target.indexName} missing or invalid`)
    }

    const nulls = await client.query<{ count: string; orphans: string }>(
      `SELECT count(*)::text AS count,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "${schema}"."${target.parentTable}" p WHERE p.id = child.${target.parentKey}))::text AS orphans
       FROM "${schema}"."${target.table}" AS child
       WHERE child.workspace_id IS NULL`,
    )
    if (nulls.rows[0]?.count !== "0") {
      throw new Error(`${WORKSPACE_ID_MIGRATION}: backfill postcondition failed: ${nulls.rows[0]?.count} ${target.table} rows still have NULL workspace_id (${nulls.rows[0]?.orphans} have no ${target.parentTable} parent)`)
    }

    const mismatched = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM "${schema}"."${target.table}" AS child
       JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
       WHERE child.workspace_id IS DISTINCT FROM parent.workspace_id`,
    )
    if (mismatched.rows[0]?.count !== "0") {
      throw new Error(`${WORKSPACE_ID_MIGRATION}: agreement postcondition failed: ${mismatched.rows[0]?.count} ${target.table} rows disagree with their ${target.parentTable} parent's workspace_id`)
    }
  }
}
