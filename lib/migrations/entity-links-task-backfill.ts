import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of ADR phase 7 (TaskLink) on the generic entity_links table. No DDL: 091 created entity_links, 027 created task_links.
 *
 *   TASK_REFERENCES  <- task_links   (task -> OPPORTUNITY | SOLUTION | ROADMAP_ITEM | OBJECTIVE | KEY_RESULT | DOC | EXPERIMENT |
 *                                     FEEDBACK_ITEM | DECISION)   origin DIRECT; source, created_by_id and created_at are COPIED;
 *                                     DECISION is stored as REVIEW_REQUEST (lib/entity-types.ts alias), so the alias never reaches a row
 *
 * task_links stays the source of truth; this only fills the mirror that lib/task-link-writes.ts keeps in step from now on. EXPLICIT-ONLY:
 * never part of an untargeted run; POST it by name after the mirroring code is deployed and COMPASS_ENTITY_LINKS_TASK_MIRROR is on, so
 * nothing slips in unmirrored while it runs.
 *
 * Steps, each in committed batches of 500 (a link is 4 DSQL-modified rows, the cap is 3,000), KEYSET-paged by id so a batch never rescans the
 * rows an earlier batch passed (task_links is the largest link table):
 *   1. prune  mirror rows with no legacy counterpart (the legacy row went while the flag was off, or a target-delete drain failed); the
 *             counterpart is re-checked inside the DELETE itself, so a row that gained one meanwhile survives;
 *   2. repair mirror rows whose workspace_id, origin or to_type disagrees with the legacy row (one plain UPDATE per workspace group);
 *   3. insert the legacy rows that have no mirror row, one target type at a time (anti-join on the unique pair index; no ON CONFLICT, which
 *             is unproven against DSQL's async unique index). A unique-index race with a live writer re-selects (bounded).
 * Idempotent and resumable: a finished table selects nothing in any step. Nothing scans entity_links by link_type alone except prune and the
 * postconditions (entity_links has no index that leads with link_type); everything else enters through task_links' (linked_type, linked_id)
 * index and the entity_links pair index.
 *
 * NOT MIRRORED, BY DESIGN: linked_type COMMENT (the Doc comment a task was made from). It is counted in the status, never quarantined.
 *
 * QUARANTINE. A legacy row is mirrored only when it is consistent: its task and its target exist, and both are in one workspace (a target
 * with no workspace fails closed). Every other row is left exactly as it is, never linked and never deleted, and REPORTED (counts plus capped
 * ids in the POST log and in GET /api/admin/migrate): `dangling` (task or target gone), `crossWorkspace` (task and target in different
 * workspaces), `unsupportedType` (a linked_type that is neither one of the nine nor COMMENT). Who resolves a quarantined row is a human
 * decision outside this migration.
 *
 * Before the receipt the postconditions prove: zero unmatched non-quarantined legacy rows, zero duplicate pairs, every mirror row's
 * workspace_id equals its task's and its target's, and no mirror row has a missing endpoint unless its legacy counterpart is one of the
 * reported quarantined rows (those mirror rows are KEPT and reported, never deleted).
 *
 * A residual re-run migration (the 072 / 094 pattern) is NOT built here: re-POSTing 097 is its own residual pass. If the read flip needs a
 * separately numbered one, register a DDL-free migration that calls the same two exported functions.
 */
export const ENTITY_LINKS_TASK_BACKFILL_MIGRATION = "097_entity_links_backfill_task"

export const TASK_REFERENCES_KEY = "TASK_REFERENCES"

/** DSQL caps a write transaction at 3,000 modified rows; each mirror row is the row plus 3 index entries. */
export const ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE = 500
/** How many quarantined ids the POST log and the GET status name per class. */
const REPORTED_ID_CAP = 50
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

type Sleep = (ms: number) => Promise<void>

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_TASK_BACKFILL_MIGRATION}: ${message}`)

export type QuarantineClass = "dangling" | "crossWorkspace" | "unsupportedType"
const CLASSES: readonly QuarantineClass[] = ["dangling", "crossWorkspace", "unsupportedType"]

/** One legacy `linked_type`, the entity_links `to_type` it is stored under, and where its workspace lives. */
type Target = { legacy: string; stored: string; table: string; viaObjective?: true }

/** Explicit, one row per type (no computed table names). Key results have no reliable workspace of their own: it comes from the objective. */
const TARGETS: readonly Target[] = [
  { legacy: "OPPORTUNITY", stored: "OPPORTUNITY", table: "opportunities" },
  { legacy: "SOLUTION", stored: "SOLUTION", table: "solutions" },
  { legacy: "ROADMAP_ITEM", stored: "ROADMAP_ITEM", table: "roadmap_items" },
  { legacy: "OBJECTIVE", stored: "OBJECTIVE", table: "objectives" },
  { legacy: "KEY_RESULT", stored: "KEY_RESULT", table: "key_results", viaObjective: true },
  { legacy: "DOC", stored: "DOC", table: "docs" },
  { legacy: "EXPERIMENT", stored: "EXPERIMENT", table: "experiments" },
  { legacy: "FEEDBACK_ITEM", stored: "FEEDBACK_ITEM", table: "feedback" },
  { legacy: "DECISION", stored: "REVIEW_REQUEST", table: "review_requests" },
]
const MIRRORED_LEGACY_TYPES = TARGETS.map((target) => `'${target.legacy}'`).join(", ")

// ── SQL fragments (one place, so the backfill, the postconditions and the status cannot disagree) ──────────────────

/** Legacy rows of one target type with their task and target (LEFT JOINs: a missing endpoint is a class, not a vanished row). */
const source = (s: string, target: Target) => `"${s}"."task_links" AS l
         LEFT JOIN "${s}"."tasks" AS t ON t.id = l.task_id
         LEFT JOIN "${s}"."${target.table}" AS x ON x.id = l.linked_id${target.viaObjective ? `\n         LEFT JOIN "${s}"."objectives" AS xo ON xo.id = x.objective_id` : ""}`

const targetWorkspace = (target: Target) => (target.viaObjective ? "xo.workspace_id" : "x.workspace_id")

/** 'ok' = mirrorable; anything else is the quarantine class. First match wins. */
const classOf = (target: Target) => `CASE
           WHEN t.id IS NULL OR x.id IS NULL${target.viaObjective ? " OR xo.id IS NULL" : ""} THEN 'dangling'
           WHEN t.workspace_id IS NULL OR ${targetWorkspace(target)} IS NULL OR t.workspace_id <> ${targetWorkspace(target)} THEN 'crossWorkspace'
           ELSE 'ok' END`

/** The mirror row of a legacy row, matched on the unique pair (from_id, link_type, to_id). */
const mirrorJoin = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = l.task_id AND e.link_type = '${TASK_REFERENCES_KEY}' AND e.to_id = l.linked_id`

/** A legacy counterpart of mirror row alias `e` under alias `c`: same task, same target, the legacy spelling of the stored type. */
const counterpart = (s: string) => `"${s}"."task_links" AS c WHERE c.task_id = e.from_id AND c.linked_id = e.to_id AND c.linked_type = CASE e.to_type WHEN 'REVIEW_REQUEST' THEN 'DECISION' ELSE e.to_type END`

// ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fail closed, before any write: 068 (objective/solution workspace_id) and 091 (entity_links) must be complete, and every table the backfill reads must exist. */
export async function assertEntityLinksTaskPreconditions(client: PoolClient, schema: string) {
  for (const required of ["068_workspace_id_on_solution_objective", "091_entity_links"]) {
    const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [required])
    if (receipt === 0) throw refuse(`precondition failed: ${required} is not applied. Apply it first; nothing was changed.`)
  }
  const present = await client.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND (
       (table_name = 'objectives' AND column_name = 'workspace_id') OR (table_name = 'solutions' AND column_name = 'workspace_id')
       OR (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'task_links' AND column_name = 'source')
       OR (table_name = 'tasks' AND column_name = 'workspace_id') OR (table_name = 'review_requests' AND column_name = 'workspace_id'))`,
    [schema],
  )
  if (present.rows.length !== 6) throw refuse("precondition failed: objectives, solutions, tasks, review_requests, task_links or entity_links is missing a column the backfill needs. Nothing was changed.")
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
      if ((retries += 1) > 5) throw refuse("a live writer kept racing the same batch of mirror inserts; re-POST to resume")
      continue
    }
    retries = 0
    total += changed
    after = rows[rows.length - 1].id
  }
}

/** Mirror rows whose legacy counterpart is gone. The counterpart is re-checked inside the DELETE itself, so a row that gained one in between survives. */
async function pruneStaleMirrorRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  const stale = `e.link_type = '${TASK_REFERENCES_KEY}' AND NOT EXISTS (SELECT 1 FROM ${counterpart(schema)})`
  return pagedBatches(
    async (after) => (await client.query<{ id: string }>(`SELECT e.id AS id FROM "${schema}"."entity_links" AS e WHERE e.id > $1::uuid AND ${stale} ORDER BY e.id LIMIT $2`, [after, ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE])).rows,
    async (ids) => (await withOccRetry(() => client.query(`DELETE FROM "${schema}"."entity_links" AS e WHERE e.id = ANY($1::uuid[]) AND ${stale}`, [ids]), sleep)).rowCount ?? 0,
  )
}

/** Mirror rows of consistent legacy rows whose workspace_id, origin or to_type disagrees. */
async function repairDriftedMirrorRows(client: PoolClient, schema: string, target: Target, sleep?: Sleep): Promise<number> {
  let repaired = 0
  let after = NIL_UUID
  while (true) {
    const batch = await client.query<{ id: string; workspace_id: string }>(
      `SELECT e.id AS id, t.workspace_id AS workspace_id
         FROM ${source(schema, target)} ${mirrorJoin(schema)}
         WHERE l.linked_type = '${target.legacy}' AND e.id IS NOT NULL AND e.id > $1::uuid AND (${classOf(target)}) = 'ok'
           AND (e.workspace_id <> t.workspace_id OR e.origin <> 'DIRECT' OR e.to_type <> '${target.stored}')
         ORDER BY e.id LIMIT $2`,
      [after, ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return repaired
    // One plain UPDATE per workspace group: no multi-array unnest, which is not proven on DSQL.
    const groups = new Map<string, string[]>()
    for (const row of batch.rows) groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row.id])
    for (const [workspaceId, ids] of groups) {
      const result = await withOccRetry(
        () => client.query(
          `UPDATE "${schema}"."entity_links" SET workspace_id = $1::uuid, origin = 'DIRECT', to_type = '${target.stored}', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::uuid[])`,
          [workspaceId, ids],
        ),
        sleep,
      )
      repaired += result.rowCount ?? 0
    }
    after = batch.rows[batch.rows.length - 1].id
  }
}

/** Legacy rows of one target type that have no mirror row. The INSERT re-checks the task and the target (class ok) so a row that went bad since the select is not linked. Select the ids, then copy the columns in SQL so timestamps never round-trip through the driver. */
async function insertMissingMirrorRows(client: PoolClient, schema: string, target: Target, sleep?: Sleep): Promise<number> {
  return pagedBatches(
    async (after) =>
      (await client.query<{ id: string }>(
        `SELECT l.id AS id FROM ${source(schema, target)} ${mirrorJoin(schema)}
         WHERE l.linked_type = '${target.legacy}' AND e.id IS NULL AND l.id > $1::uuid AND (${classOf(target)}) = 'ok'
         ORDER BY l.id LIMIT $2`,
        [after, ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE],
      )).rows,
    async (ids) => {
      try {
        const result = await withOccRetry(
          () => client.query(
            `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
             SELECT t.workspace_id, '${TASK_REFERENCES_KEY}', 'TASK', l.task_id, '${target.stored}', l.linked_id, 'DIRECT', l.source, l.created_by_id, l.created_at, CURRENT_TIMESTAMP
             FROM ${source(schema, target)}
             WHERE l.id = ANY($1::uuid[]) AND l.linked_type = '${target.legacy}' AND (${classOf(target)}) = 'ok'`,
            [ids],
          ),
          sleep,
        )
        return result.rowCount ?? 0
      } catch (error) {
        // A live writer mirrored one of these pairs between the select and the insert: the unique pair index refused the whole batch
        // (nothing was written), so re-select; the anti-join now excludes the winner. Bounded, then it fails closed.
        if ((error as { code?: string } | null)?.code === "23505") return "retry"
        throw error
      }
    },
  )
}

export type TaskLinksQuarantine = Record<QuarantineClass, { count: number; ids: string[] }>

/**
 * The legacy rows that are NOT mirrored, by class, with up to REPORTED_ID_CAP ids each (task_links.id). Read-only; used by the POST log, the
 * postconditions and GET /api/admin/migrate. COMMENT rows are excluded by design and are not part of it.
 */
export async function findQuarantinedTaskLinks(client: PoolClient, schema: string): Promise<TaskLinksQuarantine> {
  const out = Object.fromEntries(CLASSES.map((cls) => [cls, { count: 0, ids: [] as string[] }])) as TaskLinksQuarantine
  for (const target of TARGETS) {
    const byClass = await client.query<{ cls: string; n: string }>(
      `SELECT cls, count(*)::text AS n FROM (SELECT (${classOf(target)}) AS cls FROM ${source(schema, target)} WHERE l.linked_type = '${target.legacy}') AS classified WHERE cls <> 'ok' GROUP BY cls`,
    )
    for (const row of byClass.rows) {
      const entry = out[row.cls as QuarantineClass]
      entry.count += num(row.n)
      const room = REPORTED_ID_CAP - entry.ids.length
      if (room > 0) {
        const ids = await client.query<{ id: string }>(
          `SELECT id FROM (SELECT l.id AS id, (${classOf(target)}) AS cls FROM ${source(schema, target)} WHERE l.linked_type = '${target.legacy}') AS classified WHERE cls = $1 ORDER BY id LIMIT ${room}`,
          [row.cls],
        )
        entry.ids.push(...ids.rows.map((r) => r.id))
      }
    }
  }
  const unsupported = `FROM "${schema}"."task_links" AS l WHERE l.linked_type NOT IN (${MIRRORED_LEGACY_TYPES}, 'COMMENT')`
  out.unsupportedType.count = await count(client, `SELECT count(*)::text AS n ${unsupported}`)
  if (out.unsupportedType.count > 0) out.unsupportedType.ids = (await client.query<{ id: string }>(`SELECT l.id AS id ${unsupported} ORDER BY l.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((r) => r.id)
  return out
}

function logList(label: string, entry: { count: number; ids: string[] }, unit: string): string | null {
  if (entry.count === 0) return null
  const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
  return `  ! ${label} ${entry.count} ${unit}: ${entry.ids.join(", ")}${more}`
}

/**
 * Backfills TASK_REFERENCES. Idempotent and resumable (see the file comment). Returns what it did so the caller and the tests can assert on it.
 */
export async function backfillEntityLinksTask(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ pruned: number; repaired: number; inserted: number; quarantined: TaskLinksQuarantine; keptMirrorRows: MirrorRowsKept }> {
  await assertEntityLinksTaskPreconditions(client, schema)

  const pruned = await pruneStaleMirrorRows(client, schema, sleep)
  let repaired = 0
  let inserted = 0
  for (const target of TARGETS) {
    repaired += await repairDriftedMirrorRows(client, schema, target, sleep)
    inserted += await insertMissingMirrorRows(client, schema, target, sleep)
  }
  log.push(`  ✓ ${TASK_REFERENCES_KEY}: inserted ${inserted}, repaired ${repaired}, pruned ${pruned} stale mirror rows`)

  const quarantined = await findQuarantinedTaskLinks(client, schema)
  for (const cls of CLASSES) {
    const line = logList(`quarantined`, quarantined[cls], `task_links row(s) of class ${cls}, left unlinked and untouched (task_links ids)`)
    if (line) log.push(line)
  }
  const keptMirrorRows = await findMirrorRowsKeptForQuarantine(client, schema)
  const kept = logList("kept", keptMirrorRows, "mirror row(s) whose legacy row is quarantined, not deleted (entity_links ids)")
  if (kept) log.push(kept)
  return { pruned, repaired, inserted, quarantined, keptMirrorRows }
}

// ── Postconditions ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Mirror rows with their task, their legacy counterpart and (through conditional joins, so only the matching table is probed) their target.
 * One pass over the mirror rows whatever the target type.
 */
const mirrorRows = (s: string) => `"${s}"."entity_links" AS e
         LEFT JOIN "${s}"."tasks" AS tk ON tk.id = e.from_id
         LEFT JOIN "${s}"."task_links" AS l ON l.task_id = e.from_id AND l.linked_id = e.to_id AND l.linked_type = CASE e.to_type WHEN 'REVIEW_REQUEST' THEN 'DECISION' ELSE e.to_type END
${TARGETS.map((target) => `         LEFT JOIN "${s}"."${target.table}" AS x_${target.stored.toLowerCase()} ON e.to_type = '${target.stored}' AND x_${target.stored.toLowerCase()}.id = e.to_id`).join("\n")}
         LEFT JOIN "${s}"."objectives" AS xo ON e.to_type = 'KEY_RESULT' AND xo.id = x_key_result.objective_id`

const targetExists = `(${TARGETS.map((target) => `(e.to_type = '${target.stored}' AND x_${target.stored.toLowerCase()}.id IS NOT NULL${target.viaObjective ? " AND xo.id IS NOT NULL" : ""})`).join(" OR ")})`
const targetWorkspaceOfMirror = `CASE e.to_type ${TARGETS.map((target) => `WHEN '${target.stored}' THEN ${target.viaObjective ? "xo.workspace_id" : `x_${target.stored.toLowerCase()}.workspace_id`}`).join(" ")} END`
/** The mirror row's endpoints are missing, or the task and the target are in different workspaces (the legacy row, if any, is quarantined). */
const endpointsBad = `(tk.id IS NULL OR NOT ${targetExists} OR ${targetWorkspaceOfMirror} IS NULL OR tk.workspace_id <> ${targetWorkspaceOfMirror})`
/** The mirror row's own workspace_id disagrees with its task's or its target's. */
const stampMismatch = `(e.workspace_id IS DISTINCT FROM tk.workspace_id OR e.workspace_id IS DISTINCT FROM ${targetWorkspaceOfMirror})`

export type MirrorRowsKept = { count: number; ids: string[] }

/**
 * Mirror rows (entity_links.id) whose legacy counterpart exists but is one of the quarantined rows, for example a target deleted after the
 * mirror row was written and the legacy row not yet cleaned up. They are KEPT (never deleted here) and reported; the postconditions allow
 * them only because they are listed. Read-only.
 */
export async function findMirrorRowsKeptForQuarantine(client: PoolClient, schema: string): Promise<MirrorRowsKept> {
  const where = `e.link_type = '${TASK_REFERENCES_KEY}' AND l.id IS NOT NULL AND ${endpointsBad}`
  return {
    count: await count(client, `SELECT count(*)::text AS n FROM ${mirrorRows(schema)} WHERE ${where}`),
    ids: (await client.query<{ id: string }>(`SELECT e.id AS id FROM ${mirrorRows(schema)} WHERE ${where} ORDER BY e.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((row) => row.id),
  }
}

const unmatchedFor = (s: string, target: Target) => `SELECT count(*)::text AS n FROM ${source(s, target)} ${mirrorJoin(s)}
         WHERE l.linked_type = '${target.legacy}' AND (${classOf(target)}) = 'ok'
           AND (e.id IS NULL OR e.origin <> 'DIRECT' OR e.workspace_id <> t.workspace_id OR e.to_type <> '${target.stored}')`

/**
 * All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes):
 *   1. no consistent legacy row lacks its mirror row (workspace_id, origin and to_type included);
 *   2. no duplicate (from, type, to) pair;
 *   3. every mirror row's workspace_id equals its task's and its target's, and no endpoint is missing, except where the legacy counterpart is
 *      one of the reported quarantined rows (a legacy row that is itself dangling or cross-workspace is reported, never repaired here).
 */
export async function assertEntityLinksTaskBackfill(client: PoolClient, schema: string) {
  let unmatched = 0
  for (const target of TARGETS) unmatched += await count(client, unmatchedFor(schema, target))
  if (unmatched !== 0) throw refuse(`coverage postcondition failed: ${unmatched} consistent task_links rows have no matching ${TASK_REFERENCES_KEY} row`)

  const duplicates = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type = '${TASK_REFERENCES_KEY}' GROUP BY from_id, link_type, to_id HAVING count(*) > 1
       ) AS dup`)
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)

  // Unexplained = the mirror row is broken AND no legacy row accounts for it (a mirror row with a quarantined legacy row is reported, not refused).
  const dangling = await count(client, `SELECT count(*)::text AS n FROM ${mirrorRows(schema)} WHERE e.link_type = '${TASK_REFERENCES_KEY}' AND l.id IS NULL AND (tk.id IS NULL OR NOT ${targetExists})`)
  if (dangling !== 0) throw refuse(`integrity postcondition failed: ${dangling} ${TASK_REFERENCES_KEY} rows have a missing endpoint and no legacy row to account for it`)
  const mismatch = await count(client, `SELECT count(*)::text AS n FROM ${mirrorRows(schema)} WHERE e.link_type = '${TASK_REFERENCES_KEY}' AND (l.id IS NULL OR NOT ${endpointsBad}) AND (${endpointsBad} OR ${stampMismatch})`)
  if (mismatch !== 0) throw refuse(`tenant postcondition failed: ${mismatch} ${TASK_REFERENCES_KEY} rows have a workspace_id that differs from an endpoint's`)
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type EntityLinksTaskStatus = {
  legacyTaskLinks: number
  legacyTaskLinksByType: Record<string, number>
  /** linked_type COMMENT: not mirrored by design, never quarantined. */
  commentLinksExcluded: number
  mirroredTaskReferences: number
  /** Consistent legacy rows the backfill would still insert or repair. */
  unmatched: number
  /** Mirror rows with no legacy counterpart; a re-POST prunes them. */
  staleMirrorRows: number
  quarantined: TaskLinksQuarantine
  /** Mirror rows kept (not deleted) because their legacy row is quarantined. */
  mirrorRowsKeptForQuarantine: MirrorRowsKept
}

/**
 * Counts and capped ids only (no titles or content). Throws if a table is missing; the caller turns that into an error field. Cost: one pass
 * over task_links per target type plus two passes over the mirror rows (entity_links cannot be entered by link_type alone), so poll it sparingly.
 */
export async function getEntityLinksTaskStatus(client: PoolClient, schema: string): Promise<EntityLinksTaskStatus> {
  const byType = await client.query<{ linked_type: string; n: string }>(`SELECT linked_type, count(*)::text AS n FROM "${schema}"."task_links" GROUP BY linked_type`)
  const legacyTaskLinksByType = Object.fromEntries(byType.rows.map((row) => [row.linked_type, num(row.n)]))
  let unmatched = 0
  for (const target of TARGETS) unmatched += await count(client, unmatchedFor(schema, target))
  return {
    legacyTaskLinks: Object.values(legacyTaskLinksByType).reduce((sum, n) => sum + n, 0),
    legacyTaskLinksByType,
    commentLinksExcluded: legacyTaskLinksByType.COMMENT ?? 0,
    mirroredTaskReferences: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${TASK_REFERENCES_KEY}'`),
    unmatched,
    staleMirrorRows: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e WHERE e.link_type = '${TASK_REFERENCES_KEY}' AND NOT EXISTS (SELECT 1 FROM ${counterpart(schema)})`),
    quarantined: await findQuarantinedTaskLinks(client, schema),
    mirrorRowsKeptForQuarantine: await findMirrorRowsKeptForQuarantine(client, schema),
  }
}
