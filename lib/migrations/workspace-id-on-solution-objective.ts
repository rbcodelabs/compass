import type { PoolClient } from "pg"

export const WORKSPACE_ID_MIGRATION = "068_workspace_id_on_solution_objective"

/**
 * DSQL caps a write transaction at 3,000 modified rows, and each row also
 * maintains the new workspace_id index. 500 keeps well inside that.
 */
export const WORKSPACE_ID_BACKFILL_BATCH_SIZE = 500

/** Aurora DSQL uses optimistic concurrency: a conflicting commit fails with SQLSTATE 40001 (OC000/OC001) and must be retried. */
export const OCC_MAX_ATTEMPTS = 6
const OCC_BASE_DELAY_MS = 50

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

export function isOccConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === "40001" || /\bOC00[01]\b|change conflicts with another transaction/i.test(e?.message ?? "")
}

/**
 * Runs one short write, retrying optimistic-concurrency conflicts with bounded
 * exponential backoff. Anything else, and a conflict that outlives the bound,
 * is thrown so the migration stays unfinished rather than silently partial.
 */
export async function withOccRetry<T>(
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      if (!isOccConflict(error) || attempt >= OCC_MAX_ATTEMPTS) throw error
      await sleep(OCC_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * OCC_BASE_DELAY_MS))
    }
  }
}

/**
 * Fills workspace_id from the parent row in bounded batches. Idempotent and
 * resumable: only rows still NULL are touched, each write is its own short
 * transaction, and a rerun after a crash simply continues.
 *
 * Deliberately plain SQL (a keyed SELECT ... LIMIT, then UPDATE ... WHERE id =
 * ANY($1) AND workspace_id IS NULL) rather than a CTE-with-LIMIT UPDATE ... FROM,
 * which is the construct most likely to differ between PostgreSQL and DSQL. A row
 * whose parent is missing never appears in the SELECT join and is left NULL for
 * the postcondition to report, so the loop always terminates.
 */
export async function backfillWorkspaceIdOnSolutionObjective(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: (ms: number) => Promise<void>,
) {
  for (const target of TARGETS) {
    let total = 0
    while (true) {
      const batch = await client.query<{ id: string; workspace_id: string }>(
        `SELECT child.id, parent.workspace_id
         FROM "${schema}"."${target.table}" AS child
         JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
         WHERE child.workspace_id IS NULL
         LIMIT $1`,
        [WORKSPACE_ID_BACKFILL_BATCH_SIZE],
      )
      if (batch.rows.length === 0) break
      const idsByWorkspace = new Map<string, string[]>()
      for (const row of batch.rows) {
        const ids = idsByWorkspace.get(row.workspace_id) ?? []
        ids.push(row.id)
        idsByWorkspace.set(row.workspace_id, ids)
      }
      for (const [workspaceId, ids] of idsByWorkspace) {
        // The IS NULL guard makes a retried or concurrent run harmless.
        const result = await withOccRetry(
          () => client.query(
            `UPDATE "${schema}"."${target.table}" SET workspace_id = $1 WHERE id = ANY($2::uuid[]) AND workspace_id IS NULL`,
            [workspaceId, ids],
          ),
          sleep,
        )
        total += result.rowCount ?? 0
      }
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

    // LEFT JOIN instead of a correlated NOT EXISTS inside an aggregate FILTER:
    // count(parent.id) only counts rows whose parent exists, so orphans = total - withParent.
    const nulls = await client.query<{ total: string; with_parent: string }>(
      `SELECT count(*)::text AS total, count(parent.id)::text AS with_parent
       FROM "${schema}"."${target.table}" AS child
       LEFT JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
       WHERE child.workspace_id IS NULL`,
    )
    const total = Number(nulls.rows[0]?.total ?? "0")
    if (total !== 0) {
      const orphans = total - Number(nulls.rows[0]?.with_parent ?? "0")
      throw new Error(`${WORKSPACE_ID_MIGRATION}: backfill postcondition failed: ${total} ${target.table} rows still have NULL workspace_id (${orphans} have no ${target.parentTable} parent)`)
    }

    // NULLs were ruled out above, so a plain inequality is exact here.
    const mismatched = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM "${schema}"."${target.table}" AS child
       JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
       WHERE child.workspace_id <> parent.workspace_id`,
    )
    if (mismatched.rows[0]?.count !== "0") {
      throw new Error(`${WORKSPACE_ID_MIGRATION}: agreement postcondition failed: ${mismatched.rows[0]?.count} ${target.table} rows disagree with their ${target.parentTable} parent's workspace_id`)
    }
  }
}

export type WorkspaceIdBackfillStatus = {
  columnsPresent: boolean
  /** Rows whose parent is gone: the backfill cannot derive a workspace for these, so the migration would fail until they are repaired. Computable before the migration runs. */
  orphans: { solutions: number; objectives: number }
  /** Only populated once the columns exist. */
  nullWorkspaceId: { solutions: number; objectives: number } | null
  /** Non-NULL workspace_id that disagrees with the parent's. Only populated once the columns exist. */
  parentDrift: { solutions: number; objectives: number } | null
}

/**
 * Read-only preflight for GET /api/admin/migrate so a human can see orphan /
 * NULL / drift counts BEFORE posting 068 (and confirm they are zero after).
 */
export async function getWorkspaceIdBackfillStatus(client: PoolClient, schema: string): Promise<WorkspaceIdBackfillStatus> {
  const present = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'workspace_id' AND table_name = ANY($2::text[])",
    [schema, TARGETS.map((t) => t.table)],
  )
  const columnsPresent = TARGETS.every((t) => present.rows.some((r) => r.table_name === t.table))
  const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n ?? "0")
  const orphans = { solutions: 0, objectives: 0 }
  const nullWorkspaceId = { solutions: 0, objectives: 0 }
  const parentDrift = { solutions: 0, objectives: 0 }
  for (const target of TARGETS) {
    const q = `"${schema}"."${target.table}" AS child`
    const join = `LEFT JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}`
    orphans[target.table] = await count(`SELECT count(*)::text AS n FROM ${q} ${join} WHERE parent.id IS NULL`)
    if (columnsPresent) {
      nullWorkspaceId[target.table] = await count(`SELECT count(*)::text AS n FROM ${q} WHERE child.workspace_id IS NULL`)
      parentDrift[target.table] = await count(
        `SELECT count(*)::text AS n FROM ${q} JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey} WHERE child.workspace_id IS NOT NULL AND child.workspace_id <> parent.workspace_id`,
      )
    }
  }
  return { columnsPresent, orphans, nullWorkspaceId: columnsPresent ? nullWorkspaceId : null, parentDrift: columnsPresent ? parentDrift : null }
}
