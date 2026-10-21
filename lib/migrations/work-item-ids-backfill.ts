import type { PoolClient } from "pg"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES, type WorkItemType } from "@/lib/work-item-ids"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"
import { WORKSPACE_SEQUENCES_TABLE } from "@/lib/migrations/work-item-ids"

/**
 * Data half of human-readable work item IDs. No DDL: 092 added the columns, the counter table and the
 * unique indexes; this numbers the rows that already exist.
 *
 *   1. key_results and assumptions get workspace_id from their parent (objective / solution), exactly
 *      like 068 did for solutions and objectives.
 *   2. Every row of the 14 numbered tables with seq_number IS NULL is numbered per (workspace, type),
 *      oldest first (created_at, id), by taking a range from workspace_sequences. That is the same
 *      counter live creators use, so the backfill and the application can run side by side.
 *
 * Idempotent and resumable: only NULL rows are touched, each batch is its own short transaction, and a
 * crash simply continues. 094 re-runs the very same hook for rows that old code inserted after 093.
 */
export const WORK_ITEM_IDS_BACKFILL_MIGRATION = "093_work_item_ids_backfill"
/** Later, DDL-free second pass for rows the previous deploy inserted without a number after 093's receipt. */
export const WORK_ITEM_IDS_RESIDUAL_MIGRATION = "094_work_item_ids_residual_backfill"

/** DSQL caps a write transaction at 3,000 modified rows; each numbered row also maintains the unique index. */
export const WORK_ITEM_IDS_BACKFILL_BATCH_SIZE = 500

const PARENT_BACKFILLS = [
  { table: "key_results", parentTable: "objectives", parentKey: "objective_id" },
  { table: "assumptions", parentTable: "solutions", parentKey: "solution_id" },
] as const

type Sleep = (ms: number) => Promise<void>

/** Thrown inside a batch transaction when another writer numbered a row first; the batch is rolled back and re-selected. */
class BatchRaced extends Error {}

async function backfillParentWorkspaceIds(client: PoolClient, schema: string, log: string[], sleep?: Sleep) {
  for (const target of PARENT_BACKFILLS) {
    let total = 0
    while (true) {
      const batch = await client.query<{ id: string; workspace_id: string }>(
        `SELECT child.id, parent.workspace_id
         FROM "${schema}"."${target.table}" AS child
         JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey}
         WHERE child.workspace_id IS NULL AND parent.workspace_id IS NOT NULL
         LIMIT $1`,
        [WORK_ITEM_IDS_BACKFILL_BATCH_SIZE],
      )
      if (batch.rows.length === 0) break
      const idsByWorkspace = new Map<string, string[]>()
      for (const row of batch.rows) {
        const ids = idsByWorkspace.get(row.workspace_id) ?? []
        ids.push(row.id)
        idsByWorkspace.set(row.workspace_id, ids)
      }
      for (const [workspaceId, ids] of idsByWorkspace) {
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

/** Numbers one workspace's slice of a batch in a single transaction: reserve the range, then stamp the rows. */
async function numberSlice(client: PoolClient, schema: string, type: WorkItemType, workspaceId: string, ids: string[]) {
  const { table, prefix } = WORK_ITEM_REGISTRY[type]
  await client.query("BEGIN")
  try {
    const counter = await client.query<{ next_value: number }>(
      `INSERT INTO "${schema}"."${WORKSPACE_SEQUENCES_TABLE}" (workspace_id, entity_type, next_value, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (workspace_id, entity_type)
       DO UPDATE SET next_value = "${WORKSPACE_SEQUENCES_TABLE}".next_value + $4, updated_at = CURRENT_TIMESTAMP
       RETURNING next_value`,
      [workspaceId, type, ids.length + 1, ids.length],
    )
    const first = counter.rows[0].next_value - ids.length
    for (const [index, id] of ids.entries()) {
      const updated = await client.query(
        `UPDATE "${schema}"."${table}" SET seq_prefix = $1, seq_number = $2 WHERE id = $3 AND seq_number IS NULL`,
        [prefix, first + index, id],
      )
      // Another run numbered it first. Undo the reserved range too, so numbers stay dense, and re-select.
      if (updated.rowCount !== 1) throw new BatchRaced()
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function numberExistingRows(client: PoolClient, schema: string, log: string[], sleep?: Sleep) {
  for (const type of WORK_ITEM_TYPES) {
    const { table } = WORK_ITEM_REGISTRY[type]
    let total = 0
    while (true) {
      // Oldest first, grouped by workspace, so a workspace's legacy rows are numbered in creation order.
      const batch = await client.query<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM "${schema}"."${table}"
         WHERE seq_number IS NULL AND workspace_id IS NOT NULL
         ORDER BY workspace_id, created_at, id
         LIMIT $1`,
        [WORK_ITEM_IDS_BACKFILL_BATCH_SIZE],
      )
      if (batch.rows.length === 0) break
      const idsByWorkspace = new Map<string, string[]>()
      for (const row of batch.rows) {
        const ids = idsByWorkspace.get(row.workspace_id) ?? []
        ids.push(row.id)
        idsByWorkspace.set(row.workspace_id, ids)
      }
      for (const [workspaceId, ids] of idsByWorkspace) {
        try {
          await withOccRetry(() => numberSlice(client, schema, type, workspaceId, ids), sleep)
          total += ids.length
        } catch (error) {
          if (!(error instanceof BatchRaced)) throw error
        }
      }
    }
    log.push(`  ✓ numbered ${total} ${table} rows`)
  }
}

export async function backfillWorkItemIds(client: PoolClient, schema: string, log: string[], sleep?: Sleep) {
  await backfillParentWorkspaceIds(client, schema, log, sleep)
  await numberExistingRows(client, schema, log, sleep)
}

const refuse = (migrationName: string, message: string) => new WorkspaceIdBackfillRefusal(`${migrationName}: ${message}`)

/**
 * Postconditions, all of which must hold before the receipt is recorded:
 *   1. no key_results / assumptions row has a NULL workspace_id (an orphan counts);
 *   2. every row of the 14 tables has a seq_prefix equal to the registry prefix and a seq_number;
 *      a row with no workspace_id cannot be numbered, so it fails here too;
 *   3. no (workspace, prefix, number) is used twice;
 *   4. every counter is ahead of the highest number in use, so the next create cannot collide.
 */
export async function assertWorkItemIdsBackfill(client: PoolClient, schema: string, migrationName: string = WORK_ITEM_IDS_BACKFILL_MIGRATION) {
  const count = async (sql: string, params: unknown[] = []) => Number((await client.query<{ n: string }>(sql, params)).rows[0]?.n ?? "0")

  for (const target of PARENT_BACKFILLS) {
    const nulls = await count(`SELECT count(*)::text AS n FROM "${schema}"."${target.table}" WHERE workspace_id IS NULL`)
    if (nulls !== 0) throw refuse(migrationName, `backfill postcondition failed: ${nulls} ${target.table} rows still have NULL workspace_id (orphaned from their ${target.parentTable} row)`)
  }

  for (const type of WORK_ITEM_TYPES) {
    const { table, prefix } = WORK_ITEM_REGISTRY[type]
    const unnumbered = await count(`SELECT count(*)::text AS n FROM "${schema}"."${table}" WHERE seq_number IS NULL OR seq_prefix IS NULL`)
    if (unnumbered !== 0) throw refuse(migrationName, `numbering postcondition failed: ${unnumbered} ${table} rows have no work item number (rows without a workspace_id cannot be numbered)`)

    const wrongPrefix = await count(`SELECT count(*)::text AS n FROM "${schema}"."${table}" WHERE seq_prefix <> $1`, [prefix])
    if (wrongPrefix !== 0) throw refuse(migrationName, `prefix postcondition failed: ${wrongPrefix} ${table} rows have a prefix other than ${prefix}`)

    const duplicates = await count(
      `SELECT count(*)::text AS n FROM (
         SELECT workspace_id FROM "${schema}"."${table}" GROUP BY workspace_id, seq_prefix, seq_number HAVING count(*) > 1
       ) AS dup`,
    )
    if (duplicates !== 0) throw refuse(migrationName, `uniqueness postcondition failed: ${duplicates} duplicate numbers in ${table}`)

    const behind = await count(
      `SELECT count(*)::text AS n FROM (
         SELECT workspace_id, max(seq_number) AS highest FROM "${schema}"."${table}" GROUP BY workspace_id
       ) AS used
       LEFT JOIN "${schema}"."${WORKSPACE_SEQUENCES_TABLE}" AS counter
         ON counter.workspace_id = used.workspace_id AND counter.entity_type = $1
       WHERE counter.next_value IS NULL OR counter.next_value <= used.highest`,
      [type],
    )
    if (behind !== 0) throw refuse(migrationName, `counter postcondition failed: ${behind} workspaces have a ${type} counter that is missing or not ahead of the highest ${prefix} number`)
  }
}

export type WorkItemIdsBackfillStatus = {
  columnsPresent: boolean
  /** Rows still without a number, per table. Only populated once 092's columns exist. */
  unnumbered: Record<string, number> | null
  /** key_results / assumptions rows with no workspace_id yet. */
  nullWorkspaceId: { key_results: number; assumptions: number } | null
  /** key_results / assumptions rows whose parent is gone: the backfill cannot derive a workspace for these. */
  orphans: { key_results: number; assumptions: number }
}

/** Read-only preflight for GET /api/admin/migrate: orphan and remaining-work counts before (and after) POSTing 093/094. */
export async function getWorkItemIdsBackfillStatus(client: PoolClient, schema: string): Promise<WorkItemIdsBackfillStatus> {
  const present = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'seq_number' AND table_name = ANY($2::text[])",
    [schema, WORK_ITEM_TYPES.map((type) => WORK_ITEM_REGISTRY[type].table)],
  )
  const columnsPresent = present.rows.length === WORK_ITEM_TYPES.length
  const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n ?? "0")
  const orphans = { key_results: 0, assumptions: 0 }
  const nullWorkspaceId = { key_results: 0, assumptions: 0 }
  for (const target of PARENT_BACKFILLS) {
    orphans[target.table] = await count(
      `SELECT count(*)::text AS n FROM "${schema}"."${target.table}" AS child
       LEFT JOIN "${schema}"."${target.parentTable}" AS parent ON parent.id = child.${target.parentKey} WHERE parent.id IS NULL`,
    )
    if (columnsPresent) nullWorkspaceId[target.table] = await count(`SELECT count(*)::text AS n FROM "${schema}"."${target.table}" WHERE workspace_id IS NULL`)
  }
  let unnumbered: Record<string, number> | null = null
  if (columnsPresent) {
    unnumbered = {}
    for (const type of WORK_ITEM_TYPES) {
      const { table } = WORK_ITEM_REGISTRY[type]
      unnumbered[table] = await count(`SELECT count(*)::text AS n FROM "${schema}"."${table}" WHERE seq_number IS NULL`)
    }
  }
  return { columnsPresent, unnumbered, nullWorkspaceId: columnsPresent ? nullWorkspaceId : null, orphans }
}
