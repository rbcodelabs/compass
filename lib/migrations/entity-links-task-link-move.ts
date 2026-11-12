import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of "move the COMMENT and AGENT_CONVERSATION task links into entity_links", so the task_links table can be dropped without
 * losing them. No DDL: 091 created entity_links, 027 created task_links.
 *
 *   TASK_CREATED_FROM <- task_links WHERE linked_type IN ('COMMENT', 'AGENT_CONVERSATION')
 *       (task TASK -> COMMENT | AGENT_CONVERSATION)   origin MIGRATION; `id`, `source`, `created_by_id` and `created_at` are COPIED and the
 *       workspace is the task's, so an id an open page holds for the link survives the move and the task screen keeps its order.
 *
 * The nine association kinds were moved earlier (097). This one is an INSERT-ONLY copy: it never deletes or changes a task_links row, and it
 * never deletes an entity_links row, because links made after the code deploy exist only in entity_links by design (the code no longer
 * writes task_links). task_links is dropped by a later change, after the status here reports zero unmoved rows.
 *
 * EXPLICIT-ONLY: never part of an untargeted run; POST it by name AFTER the code that writes and reads TASK_CREATED_FROM is deployed.
 * (History: until its receipt existed the readers fell back to the not-yet-moved task_links rows. That fallback was removed together with
 * the table by migration 116, so 115 must have run in a deployment before the code that dropped the fallback is deployed there.)
 *
 * Steps, each in committed batches of 500 (a link is 4 DSQL-modified rows, the cap is 3,000), KEYSET-paged by task_links.id so a batch never
 * rescans rows an earlier batch passed:
 *   1. repair  an existing TASK_CREATED_FROM row of a consistent legacy pair whose workspace_id or to_type disagrees (one plain UPDATE per
 *              workspace group); this only happens if a live writer or an earlier partial run left it behind;
 *   2. insert  the consistent legacy rows that have no TASK_CREATED_FROM row, one target type at a time (anti-join on the unique pair
 *              index; no ON CONFLICT, which is unproven against DSQL's async unique index). The INSERT re-checks the task and the target, so
 *              a row that went bad or was unlinked since the select is not copied. A unique-index race with a live writer re-selects (bounded).
 * Idempotent and resumable: a finished table selects nothing in any step. No SET LOCAL statement_timeout, no advisory lock, no foreign key.
 *
 * QUARANTINE. A legacy row is copied only when it is consistent: its task and its target exist, and both are in one workspace (a target
 * with no workspace fails closed). Every other row is left exactly as it is and REPORTED (counts plus capped ids in the POST log and in
 * GET /api/admin/migrate): `dangling` (task, comment or conversation gone) and `crossWorkspace`. Neither can be shown by any reader, so
 * leaving them behind loses nothing a person could see; resolving them is a human decision outside this migration.
 *
 * Before the receipt the postconditions prove, PER TYPE: zero consistent legacy rows without a matching row (pair-set equality), and the
 * number of consistent legacy rows equal to the number of entity_links rows that cover them (row-count equality, which also catches
 * duplicates); across the whole type: zero duplicate (from, type, to) pairs and every row's workspace_id equal to its task's and its
 * target's. A row whose endpoint vanished AFTER the deploy (a deleted comment) is reported, never refused: readers already hide it.
 */
export const ENTITY_LINKS_TASK_LINK_MOVE_MIGRATION = "115_entity_links_task_link_move"

export const TASK_CREATED_FROM_KEY = "TASK_CREATED_FROM"

/** DSQL caps a write transaction at 3,000 modified rows; each copied row is the row plus 3 index entries. */
export const ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE = 500
/** How many quarantined ids the POST log and the GET status name per class. */
const REPORTED_ID_CAP = 50
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

type Sleep = (ms: number) => Promise<void>

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_TASK_LINK_MOVE_MIGRATION}: ${message}`)

export type TaskLinkMoveQuarantineClass = "dangling" | "crossWorkspace"
const CLASSES: readonly TaskLinkMoveQuarantineClass[] = ["dangling", "crossWorkspace"]
export type TaskLinkMoveQuarantine = Record<TaskLinkMoveQuarantineClass, { count: number; ids: string[] }>

/** One legacy `linked_type` (it is also the stored `to_type`) and the table its target lives in. Both tables carry their own workspace_id. */
type Target = { type: "COMMENT" | "AGENT_CONVERSATION"; table: string }
const TARGETS: readonly Target[] = [
  // A Doc thread's comments are mirrored into `comments` under the same id, so one table covers both comment sources.
  { type: "COMMENT", table: "comments" },
  { type: "AGENT_CONVERSATION", table: "agent_conversations" },
]

// ── SQL fragments (one place, so the copy, the postconditions and the status cannot disagree) ──────────────────────

/** Legacy rows of one type with their task and target (LEFT JOINs: a missing endpoint is a class, not a vanished row). */
const source = (s: string) => `"${s}"."task_links" AS l
         LEFT JOIN "${s}"."tasks" AS t ON t.id = l.task_id`
const withTarget = (s: string, target: Target) => `${source(s)}
         LEFT JOIN "${s}"."${target.table}" AS x ON x.id = l.linked_id`

/** 'ok' = copyable; anything else is the quarantine class. First match wins. */
const classOf = `CASE
           WHEN t.id IS NULL OR x.id IS NULL THEN 'dangling'
           WHEN t.workspace_id IS NULL OR x.workspace_id IS NULL OR t.workspace_id <> x.workspace_id THEN 'crossWorkspace'
           ELSE 'ok' END`

/** The TASK_CREATED_FROM row of a legacy row, matched on the unique pair (from_id, link_type, to_id). */
const mirrorJoin = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = l.task_id AND e.link_type = '${TASK_CREATED_FROM_KEY}' AND e.to_id = l.linked_id`

// ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fail closed, before any write: 091 (entity_links) must be applied and every table the move reads must have the columns it needs. */
export async function assertEntityLinksTaskLinkMovePreconditions(client: PoolClient, schema: string) {
  const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, ["091_entity_links"])
  if (receipt === 0) throw refuse("precondition failed: 091_entity_links is not applied. Apply it first; nothing was changed.")
  const present = await client.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND (
       (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'task_links' AND column_name = 'source')
       OR (table_name = 'tasks' AND column_name = 'workspace_id') OR (table_name = 'comments' AND column_name = 'workspace_id')
       OR (table_name = 'agent_conversations' AND column_name = 'workspace_id'))`,
    [schema],
  )
  if (present.rows.length !== 5) throw refuse("precondition failed: entity_links, task_links, tasks, comments or agent_conversations is missing a column the move needs. Nothing was changed.")
}

// ── Batched steps ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Keyset-paged batches: `select(after)` returns up to 500 ids greater than `after` in id order; `apply` changes them; the cursor then moves
 * past the batch whatever `apply` did, so a row that stopped qualifying (a concurrent writer) is simply passed, and no batch can loop.
 * `retry` lets a caller re-run the same batch (a unique-index race) a bounded number of times.
 */
async function pagedBatches(select: (after: string) => Promise<{ id: string }[]>, apply: (ids: string[]) => Promise<number | "retry">): Promise<number> {
  let total = 0
  let after = NIL_UUID
  let retries = 0
  while (true) {
    const rows = await select(after)
    if (rows.length === 0) return total
    const changed = await apply(rows.map((row) => row.id))
    if (changed === "retry") {
      if ((retries += 1) > 5) throw refuse("a live writer kept racing the same batch of inserts; re-POST to resume")
      continue
    }
    retries = 0
    total += changed
    after = rows[rows.length - 1].id
  }
}

/** Existing TASK_CREATED_FROM rows of consistent legacy pairs whose workspace_id or to_type disagrees with the pair. */
async function repairDriftedRows(client: PoolClient, schema: string, target: Target, sleep?: Sleep): Promise<number> {
  let repaired = 0
  let after = NIL_UUID
  while (true) {
    const batch = await client.query<{ id: string; workspace_id: string }>(
      `SELECT e.id AS id, t.workspace_id AS workspace_id
         FROM ${withTarget(schema, target)} ${mirrorJoin(schema)}
         WHERE l.linked_type = '${target.type}' AND e.id IS NOT NULL AND e.id > $1::uuid AND (${classOf}) = 'ok'
           AND (e.workspace_id <> t.workspace_id OR e.to_type <> '${target.type}')
         ORDER BY e.id LIMIT $2`,
      [after, ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return repaired
    // One plain UPDATE per workspace group: no multi-array unnest, which is not proven on DSQL.
    const groups = new Map<string, string[]>()
    for (const row of batch.rows) groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row.id])
    for (const [workspaceId, ids] of groups) {
      const result = await withOccRetry(
        () => client.query(
          `UPDATE "${schema}"."entity_links" SET workspace_id = $1::uuid, to_type = '${target.type}', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::uuid[])`,
          [workspaceId, ids],
        ),
        sleep,
      )
      repaired += result.rowCount ?? 0
    }
    after = batch.rows[batch.rows.length - 1].id
  }
}

/**
 * Legacy rows of one type that have no TASK_CREATED_FROM row. Select the ids, then copy the columns in SQL so timestamps never round-trip
 * through the driver. The INSERT re-checks the task and the target (class ok) against the live rows.
 */
async function insertMissingRows(client: PoolClient, schema: string, target: Target, sleep?: Sleep): Promise<number> {
  return pagedBatches(
    async (after) =>
      (await client.query<{ id: string }>(
        `SELECT l.id AS id FROM ${withTarget(schema, target)} ${mirrorJoin(schema)}
         WHERE l.linked_type = '${target.type}' AND e.id IS NULL AND l.id > $1::uuid AND (${classOf}) = 'ok'
         ORDER BY l.id LIMIT $2`,
        [after, ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE],
      )).rows,
    async (ids) => {
      try {
        const result = await withOccRetry(
          () => client.query(
            `INSERT INTO "${schema}"."entity_links" (id, workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
             SELECT l.id, t.workspace_id, '${TASK_CREATED_FROM_KEY}', 'TASK', l.task_id, '${target.type}', l.linked_id, 'MIGRATION', l.source, l.created_by_id, l.created_at, CURRENT_TIMESTAMP
             FROM ${withTarget(schema, target)}
             WHERE l.id = ANY($1::uuid[]) AND l.linked_type = '${target.type}' AND (${classOf}) = 'ok'`,
            [ids],
          ),
          sleep,
        )
        return result.rowCount ?? 0
      } catch (error) {
        // A live writer created one of these pairs between the select and the insert: the unique pair index refused the whole batch
        // (nothing was written), so re-select; the anti-join now excludes the winner. Bounded, then it fails closed.
        if ((error as { code?: string } | null)?.code === "23505") return "retry"
        throw error
      }
    },
  )
}

/**
 * The legacy rows that are NOT copyable, by class, with up to REPORTED_ID_CAP ids each (task_links.id). Read-only; used by the POST log,
 * the postconditions and GET /api/admin/migrate.
 */
export async function findQuarantinedTaskLinkMoves(client: PoolClient, schema: string): Promise<TaskLinkMoveQuarantine> {
  const out = Object.fromEntries(CLASSES.map((cls) => [cls, { count: 0, ids: [] as string[] }])) as TaskLinkMoveQuarantine
  for (const target of TARGETS) {
    const byClass = await client.query<{ cls: string; n: string }>(
      `SELECT cls, count(*)::text AS n FROM (SELECT (${classOf}) AS cls FROM ${withTarget(schema, target)} WHERE l.linked_type = '${target.type}') AS classified WHERE cls <> 'ok' GROUP BY cls`,
    )
    for (const row of byClass.rows) {
      const entry = out[row.cls as TaskLinkMoveQuarantineClass]
      entry.count += num(row.n)
      const room = REPORTED_ID_CAP - entry.ids.length
      if (room > 0) {
        const ids = await client.query<{ id: string }>(
          `SELECT id FROM (SELECT l.id AS id, (${classOf}) AS cls FROM ${withTarget(schema, target)} WHERE l.linked_type = '${target.type}') AS classified WHERE cls = $1 ORDER BY id LIMIT ${room}`,
          [row.cls],
        )
        entry.ids.push(...ids.rows.map((r) => r.id))
      }
    }
  }
  return out
}

function logList(label: string, entry: { count: number; ids: string[] }, unit: string): string | null {
  if (entry.count === 0) return null
  const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
  return `  ! ${label} ${entry.count} ${unit}: ${entry.ids.join(", ")}${more}`
}

/** Moves the COMMENT and AGENT_CONVERSATION task links. Idempotent and resumable (see the file comment). Returns what it did. */
export async function moveTaskLinksToEntityLinks(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ repaired: number; inserted: Record<Target["type"], number>; quarantined: TaskLinkMoveQuarantine }> {
  await assertEntityLinksTaskLinkMovePreconditions(client, schema)

  let repaired = 0
  const inserted = { COMMENT: 0, AGENT_CONVERSATION: 0 }
  for (const target of TARGETS) {
    repaired += await repairDriftedRows(client, schema, target, sleep)
    inserted[target.type] = await insertMissingRows(client, schema, target, sleep)
  }
  log.push(`  ✓ ${TASK_CREATED_FROM_KEY}: inserted ${inserted.COMMENT} COMMENT and ${inserted.AGENT_CONVERSATION} AGENT_CONVERSATION link(s), repaired ${repaired}`)

  const quarantined = await findQuarantinedTaskLinkMoves(client, schema)
  for (const cls of CLASSES) {
    const line = logList("quarantined", quarantined[cls], `task_links row(s) of class ${cls}, left in place and not copied (task_links ids)`)
    if (line) log.push(line)
  }
  return { repaired, inserted, quarantined }
}

// ── Postconditions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Consistent legacy rows of one type with no matching TASK_CREATED_FROM row (workspace_id and to_type included). */
const unmatchedFor = (s: string, target: Target) => `SELECT count(*)::text AS n FROM ${withTarget(s, target)} ${mirrorJoin(s)}
         WHERE l.linked_type = '${target.type}' AND (${classOf}) = 'ok'
           AND (e.id IS NULL OR e.workspace_id <> t.workspace_id OR e.to_type <> '${target.type}')`
const consistentFor = (s: string, target: Target) => `SELECT count(*)::text AS n FROM ${withTarget(s, target)} WHERE l.linked_type = '${target.type}' AND (${classOf}) = 'ok'`
/** TASK_CREATED_FROM rows (one per legacy pair, since the pair is unique) that cover a consistent legacy row. */
const coveringFor = (s: string, target: Target) => `SELECT count(DISTINCT e.id)::text AS n FROM ${withTarget(s, target)} ${mirrorJoin(s)}
         WHERE l.linked_type = '${target.type}' AND (${classOf}) = 'ok' AND e.id IS NOT NULL AND e.to_type = '${target.type}'`

/**
 * All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes):
 *   1. per type, no consistent legacy row lacks its TASK_CREATED_FROM row (pair-set equality, workspace_id and to_type included);
 *   2. per type, the consistent legacy rows and the TASK_CREATED_FROM rows covering them are the same number (row-count equality);
 *   3. no duplicate (from, type, to) pair;
 *   4. every TASK_CREATED_FROM row whose task and target exist carries the workspace_id of both.
 */
export async function assertEntityLinksTaskLinkMove(client: PoolClient, schema: string) {
  for (const target of TARGETS) {
    const unmatched = await count(client, unmatchedFor(schema, target))
    if (unmatched !== 0) throw refuse(`coverage postcondition failed: ${unmatched} consistent ${target.type} task_links rows have no matching ${TASK_CREATED_FROM_KEY} row`)
    const consistent = await count(client, consistentFor(schema, target))
    const covering = await count(client, coveringFor(schema, target))
    if (consistent !== covering) throw refuse(`count postcondition failed for ${target.type}: ${consistent} consistent task_links rows but ${covering} covering ${TASK_CREATED_FROM_KEY} rows`)
  }

  const duplicates = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type = '${TASK_CREATED_FROM_KEY}' GROUP BY from_id, link_type, to_id HAVING count(*) > 1
       ) AS dup`)
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)

  for (const target of TARGETS) {
    const mismatch = await count(
      client,
      `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         JOIN "${schema}"."tasks" AS t ON t.id = e.from_id
         JOIN "${schema}"."${target.table}" AS x ON x.id = e.to_id
         WHERE e.link_type = '${TASK_CREATED_FROM_KEY}' AND e.to_type = '${target.type}' AND (e.workspace_id <> t.workspace_id OR e.workspace_id <> x.workspace_id)`,
    )
    if (mismatch !== 0) throw refuse(`tenant postcondition failed: ${mismatch} ${target.type} ${TASK_CREATED_FROM_KEY} rows have a workspace_id that differs from an endpoint's`)
  }
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type TaskLinkMoveTypeStatus = {
  /** All task_links rows of the type. */
  legacy: number
  /** Legacy rows the move could copy (task and target exist, one workspace). */
  consistent: number
  /** Consistent legacy rows that still have no matching entity_links row. ZERO is the go-ahead to drop task_links. */
  unmoved: number
  /** TASK_CREATED_FROM rows of the type (includes links made after the deploy, which have no legacy row). */
  entityLinks: number
}

export type EntityLinksTaskLinkMoveStatus = {
  types: Record<Target["type"], TaskLinkMoveTypeStatus>
  /** Sum of `unmoved`: zero means every consistent COMMENT and AGENT_CONVERSATION task link is in entity_links. */
  unmoved: number
  quarantined: TaskLinkMoveQuarantine
}

/**
 * Counts and capped ids only (no titles or content). Throws if a table is missing; the caller turns that into an error field. Cost: per type
 * one pass over that type's task_links rows (task_links is entered through its (linked_type, linked_id) index) plus one count of the type's
 * entity_links rows (entity_links has no index that leads with link_type alone, so that count is a scan filtered by the workspace index).
 * Poll it sparingly.
 */
export async function getEntityLinksTaskLinkMoveStatus(client: PoolClient, schema: string): Promise<EntityLinksTaskLinkMoveStatus> {
  const types = {} as Record<Target["type"], TaskLinkMoveTypeStatus>
  let unmoved = 0
  for (const target of TARGETS) {
    const entry: TaskLinkMoveTypeStatus = {
      legacy: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."task_links" WHERE linked_type = '${target.type}'`),
      consistent: await count(client, consistentFor(schema, target)),
      unmoved: await count(client, unmatchedFor(schema, target)),
      entityLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${TASK_CREATED_FROM_KEY}' AND to_type = '${target.type}'`),
    }
    unmoved += entry.unmoved
    types[target.type] = entry
  }
  return { types, unmoved, quarantined: await findQuarantinedTaskLinkMoves(client, schema) }
}
