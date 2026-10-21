import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of ADR phase 4 (Solution <-> Key Result) on the generic entity_links table. No DDL: 091 created entity_links, 071 created
 * solution_key_result_links. Phase 4 shipped as "new-only" (a partial shadow of links written while the mirror flag was on); this closes
 * the gap so the family can leave `off` on the read flip.
 *
 *   SOLUTION_TARGETS_KEY_RESULT  <- solution_key_result_links   origin DIRECT (the legacy table has no origin and the live mirror writes
 *                                   DIRECT); source, created_by_id and created_at are COPIED; workspace_id is the verified Solution's
 *
 * The legacy table stays the source of truth; this only fills the mirror that lib/links/legacy-mirror.ts keeps in step from now on.
 * EXPLICIT-ONLY: never part of an untargeted run; POST it by name after the mirroring code is deployed and
 * COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR is on, so nothing slips in unmirrored while it runs.
 *
 * In committed batches of 500 (a link is 4 DSQL-modified rows, the cap is 3,000), in this order:
 *   1. prune  mirror rows with no legacy counterpart (the legacy row went while the flag was off, or a target-delete drain failed); the
 *             counterpart is re-checked inside the DELETE itself, so a row that gained one meanwhile survives;
 *   2. repair mirror rows whose workspace_id disagrees with the legacy row's verified workspace;
 *   3. insert the legacy rows that have no mirror row (anti-join on the unique pair; no ON CONFLICT, which is unproven against DSQL's
 *             async unique index). A unique-index race with a live writer re-selects (bounded).
 * Idempotent and resumable: a finished table selects nothing in any step.
 *
 * QUARANTINE. A legacy row is mirrored only when it is consistent: the Solution, the Key Result and the Key Result's Objective exist, the
 * Solution and the Objective share a workspace, and the legacy link row carries that workspace. Every other row is left exactly as it is,
 * never linked and never deleted, and REPORTED (counts plus capped ids in the POST log and in GET /api/admin/migrate). Who resolves a
 * quarantined row is a human decision outside this migration.
 *
 * Before the receipt the postconditions prove: zero unmatched non-quarantined legacy rows, zero duplicate pairs, every mirror row's
 * workspace_id equals both endpoints', and no mirror row has a missing endpoint unless its legacy counterpart is one of the reported
 * quarantined rows.
 */
export const ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_MIGRATION = "098_entity_links_backfill_solution_key_result"

export const SOLUTION_KEY_RESULT_KEY = "SOLUTION_TARGETS_KEY_RESULT"

/** DSQL caps a write transaction at 3,000 modified rows; each mirror row is the row plus 3 index entries. */
export const ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE = 500
/** How many quarantined ids the POST log and the GET status name per class. */
const REPORTED_ID_CAP = 50

type Sleep = (ms: number) => Promise<void>

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_MIGRATION}: ${message}`)

export type QuarantineClass = "dangling" | "crossWorkspace" | "linkWorkspaceDrift"
const CLASSES: readonly QuarantineClass[] = ["dangling", "crossWorkspace", "linkWorkspaceDrift"]

// ── SQL fragments (one place, so the backfill, the postconditions and the status cannot disagree) ──────────────────

/** Every solution_key_result_links row with its endpoints (LEFT JOINs: a missing endpoint is a class, not a vanished row). Aliases: l, s, kr, obj. */
const source = (sch: string) => `"${sch}"."solution_key_result_links" AS l
         LEFT JOIN "${sch}"."solutions" AS s ON s.id = l.solution_id
         LEFT JOIN "${sch}"."key_results" AS kr ON kr.id = l.key_result_id
         LEFT JOIN "${sch}"."objectives" AS obj ON obj.id = kr.objective_id`

/** 'ok' = mirrorable; anything else is the quarantine class. First match wins. */
const classOf = `CASE
           WHEN s.id IS NULL OR kr.id IS NULL OR obj.id IS NULL THEN 'dangling'
           WHEN s.workspace_id IS NULL OR obj.workspace_id IS NULL OR s.workspace_id <> obj.workspace_id THEN 'crossWorkspace'
           WHEN l.workspace_id <> s.workspace_id THEN 'linkWorkspaceDrift'
           ELSE 'ok' END`

/** Mirror row of a legacy pair, matched on the unique pair (from_id, link_type, to_id). */
const mirrorOf = (sch: string) => `LEFT JOIN "${sch}"."entity_links" AS e ON e.from_id = l.solution_id AND e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND e.to_id = l.key_result_id`

/** A consistent legacy row whose mirror row is missing or carries the wrong workspace. */
const unmatchedWhere = `(${classOf}) = 'ok' AND (e.id IS NULL OR e.workspace_id <> s.workspace_id)`

// ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fail closed, before any write: 068 (workspace_id on solutions and objectives), 071 (legacy table) and 091 (entity_links) must be complete. */
export async function assertEntityLinksSolutionKeyResultPreconditions(client: PoolClient, schema: string) {
  for (const required of ["068_workspace_id_on_solution_objective", "071_typed_link_tables", "091_entity_links"]) {
    const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [required])
    if (receipt === 0) throw refuse(`precondition failed: ${required} is not applied. Apply it first; nothing was changed.`)
  }
  const present = await client.query<{ table_name: string }>(
    "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'objectives' AND column_name = 'workspace_id') OR (table_name = 'solutions' AND column_name = 'workspace_id') OR (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'solution_key_result_links' AND column_name = 'source'))",
    [schema],
  )
  if (present.rows.length !== 4) throw refuse("precondition failed: objectives.workspace_id, solutions.workspace_id, entity_links or solution_key_result_links is missing. Nothing was changed.")
}

// ── Batched steps ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Selects a batch and applies it until the select is empty. A batch that selected rows but changed none would loop forever, so it throws,
 * except `tolerateStalls` times in a row (a concurrent writer can legitimately make a selected row no longer qualify; the re-select then excludes it).
 */
async function drain(label: string, select: () => Promise<{ id: string }[]>, apply: (ids: string[]) => Promise<number>, tolerateStalls = 0): Promise<number> {
  let total = 0
  let stalls = 0
  while (true) {
    const rows = await select()
    if (rows.length === 0) return total
    const changed = await apply(rows.map((row) => row.id))
    if (changed === 0) {
      stalls += 1
      if (stalls > tolerateStalls) throw refuse(`${label} made no progress on ${rows.length} selected rows`)
      continue
    }
    stalls = 0
    total += changed
  }
}

/** Mirror rows with no legacy counterpart. The counterpart is re-checked in the DELETE itself, so a row that gained one in between survives. */
async function pruneStaleMirrorRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  const stale = `e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND NOT EXISTS (SELECT 1 FROM "${schema}"."solution_key_result_links" AS c WHERE c.solution_id = e.from_id AND c.key_result_id = e.to_id)`
  return drain(
    `prune ${SOLUTION_KEY_RESULT_KEY}`,
    async () => (await client.query<{ id: string }>(`SELECT e.id AS id FROM "${schema}"."entity_links" AS e WHERE ${stale} LIMIT $1`, [ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE])).rows,
    async (ids) => (await withOccRetry(() => client.query(`DELETE FROM "${schema}"."entity_links" AS e WHERE e.id = ANY($1::uuid[]) AND ${stale}`, [ids]), sleep)).rowCount ?? 0,
    3,
  )
}

/** Mirror rows of consistent legacy rows whose workspace_id disagrees with the verified Solution's. */
async function repairDriftedMirrorRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  let repaired = 0
  let stalls = 0
  while (true) {
    const batch = await client.query<{ id: string; workspace_id: string }>(
      `SELECT e.id AS id, s.workspace_id AS workspace_id FROM ${source(schema)} ${mirrorOf(schema)}
         WHERE e.id IS NOT NULL AND (${classOf}) = 'ok' AND e.workspace_id <> s.workspace_id LIMIT $1`,
      [ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return repaired
    // One plain UPDATE per workspace group: no multi-array unnest, which is not proven on DSQL.
    const groups = new Map<string, string[]>()
    for (const row of batch.rows) groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row.id])
    let changed = 0
    for (const [workspaceId, ids] of groups) {
      const result = await withOccRetry(
        () => client.query(`UPDATE "${schema}"."entity_links" SET workspace_id = $1::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::uuid[])`, [workspaceId, ids]),
        sleep,
      )
      changed += result.rowCount ?? 0
    }
    if (changed === 0) {
      // A concurrent writer can legitimately fix or remove a selected row first; the re-select then excludes it. Bounded, then it fails closed.
      stalls += 1
      if (stalls > 3) throw refuse(`repair ${SOLUTION_KEY_RESULT_KEY} made no progress on ${batch.rows.length} selected rows`)
      continue
    }
    stalls = 0
    repaired += changed
  }
}

async function insertMissingMirrorRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  let inserted = 0
  let uniqueRaces = 0
  while (true) {
    // Select the ids, then copy the columns in SQL (INSERT ... SELECT), so timestamps never round-trip through the driver.
    const batch = await client.query<{ id: string }>(`SELECT l.id AS id FROM ${source(schema)} ${mirrorOf(schema)} WHERE e.id IS NULL AND (${classOf}) = 'ok' LIMIT $1`, [
      ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE,
    ])
    if (batch.rows.length === 0) return inserted
    const ids = batch.rows.map((row) => row.id)
    let result: { rowCount: number | null }
    try {
      result = await withOccRetry(
        () => client.query(
          `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
           SELECT s.workspace_id, '${SOLUTION_KEY_RESULT_KEY}', 'SOLUTION', l.solution_id, 'KEY_RESULT', l.key_result_id, 'DIRECT', l.source, l.created_by_id, l.created_at, CURRENT_TIMESTAMP
           FROM ${source(schema)}
           WHERE l.id = ANY($1::uuid[]) AND (${classOf}) = 'ok'
             AND NOT EXISTS (SELECT 1 FROM "${schema}"."entity_links" AS x WHERE x.from_id = l.solution_id AND x.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND x.to_id = l.key_result_id)`,
          [ids],
        ),
        sleep,
      )
    } catch (error) {
      // A live writer mirrored one of these pairs between the select and the insert: the unique pair index refused the whole batch
      // (nothing was written), so re-select; the anti-join now excludes the winner. Bounded, then it fails closed.
      if ((error as { code?: string } | null)?.code === "23505" && (uniqueRaces += 1) <= 5) continue
      throw error
    }
    // The insert re-checks the endpoints and the pair itself (no reliance on the unique index), so a row that went bad or gained a mirror row
    // since the select is skipped. Zero inserted while a selected row still qualifies would loop forever, so that throws.
    if ((result.rowCount ?? 0) === 0) {
      const again = await client.query<{ id: string }>(`SELECT l.id AS id FROM ${source(schema)} ${mirrorOf(schema)} WHERE l.id = ANY($1::uuid[]) AND e.id IS NULL AND (${classOf}) = 'ok'`, [ids])
      if (again.rows.length > 0) throw refuse(`insert ${SOLUTION_KEY_RESULT_KEY} made no progress on ${ids.length} selected rows`)
    }
    inserted += result.rowCount ?? 0
  }
}

export type SolutionKeyResultQuarantine = Record<QuarantineClass, { count: number; ids: string[] }>

/**
 * The legacy rows that are NOT mirrored, by class, with up to REPORTED_ID_CAP ids each (solution_key_result_links.id).
 * Read-only; used by the POST log, the postconditions and GET /api/admin/migrate.
 */
export async function findQuarantinedSolutionKeyResultLinks(client: PoolClient, schema: string): Promise<SolutionKeyResultQuarantine> {
  const out = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, ids: [] as string[] }])) as SolutionKeyResultQuarantine
  for (const cls of CLASSES) {
    out[cls].count = await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} WHERE (${classOf}) = $1`, [cls])
    if (out[cls].count > 0) {
      out[cls].ids = (await client.query<{ id: string }>(`SELECT l.id AS id FROM ${source(schema)} WHERE (${classOf}) = $1 ORDER BY l.id LIMIT ${REPORTED_ID_CAP}`, [cls])).rows.map((r) => r.id)
    }
  }
  return out
}

function logQuarantine(log: string[], quarantine: SolutionKeyResultQuarantine) {
  for (const cls of CLASSES) {
    const entry = quarantine[cls]
    if (entry.count === 0) continue
    const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
    log.push(`  ! quarantined ${entry.count} solutionKeyResultLinks row(s) of class ${cls}, left unlinked and untouched (solution_key_result_links ids): ${entry.ids.join(", ")}${more}`)
  }
}

/** Backfills the type. Idempotent and resumable (see the file comment). Returns what it did so the caller and the tests can assert on it. */
export async function backfillEntityLinksSolutionKeyResult(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ pruned: number; repaired: number; inserted: number; quarantined: SolutionKeyResultQuarantine; keptMirrorRows: MirrorRowsKept }> {
  await assertEntityLinksSolutionKeyResultPreconditions(client, schema)

  const pruned = await pruneStaleMirrorRows(client, schema, sleep)
  const repaired = await repairDriftedMirrorRows(client, schema, sleep)
  const inserted = await insertMissingMirrorRows(client, schema, sleep)
  log.push(`  ✓ ${SOLUTION_KEY_RESULT_KEY}: inserted ${inserted}, repaired ${repaired}, pruned ${pruned} stale mirror rows`)

  const quarantined = await findQuarantinedSolutionKeyResultLinks(client, schema)
  logQuarantine(log, quarantined)
  const keptMirrorRows = await findMirrorRowsKeptForQuarantine(client, schema)
  if (keptMirrorRows.count > 0) {
    const more = keptMirrorRows.count > keptMirrorRows.ids.length ? ` … and ${keptMirrorRows.count - keptMirrorRows.ids.length} more` : ""
    log.push(`  ! kept ${keptMirrorRows.count} solutionKeyResultLinks mirror row(s) whose legacy row is quarantined, not deleted (entity_links ids): ${keptMirrorRows.ids.join(", ")}${more}`)
  }
  return { pruned, repaired, inserted, quarantined, keptMirrorRows }
}

// ── Postconditions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirror rows with their endpoints and legacy counterpart (same aliases as `source`, so classOf applies); l is NULL for a mirror row with no counterpart. */
const mirrorRows = (sch: string) => `"${sch}"."entity_links" AS e
         LEFT JOIN "${sch}"."solution_key_result_links" AS l ON l.solution_id = e.from_id AND l.key_result_id = e.to_id
         LEFT JOIN "${sch}"."solutions" AS s ON s.id = e.from_id
         LEFT JOIN "${sch}"."key_results" AS kr ON kr.id = e.to_id
         LEFT JOIN "${sch}"."objectives" AS obj ON obj.id = kr.objective_id`

export type MirrorRowsKept = { count: number; ids: string[] }

/**
 * Mirror rows (entity_links.id) whose legacy counterpart exists but is one of the quarantined rows, for example an endpoint deleted after
 * the mirror row was written and the legacy row not yet cleaned up. They are KEPT (never deleted here) and reported; the postconditions
 * allow them only because they are listed. Read-only.
 */
export async function findMirrorRowsKeptForQuarantine(client: PoolClient, schema: string): Promise<MirrorRowsKept> {
  const where = `e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND l.id IS NOT NULL AND (${classOf}) <> 'ok'`
  return {
    count: await count(client, `SELECT count(*)::text AS n FROM ${mirrorRows(schema)} WHERE ${where}`),
    ids: (await client.query<{ id: string }>(`SELECT e.id AS id FROM ${mirrorRows(schema)} WHERE ${where} ORDER BY e.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((row) => row.id),
  }
}

/**
 * All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes):
 *   1. no consistent legacy row lacks its mirror row (workspace_id included);
 *   2. no stale mirror row (one with no legacy counterpart) and no duplicate (from, type, to) pair;
 *   3. every mirror row's workspace_id equals both endpoints', and no endpoint is missing, except where the legacy counterpart is one of
 *      the reported quarantined rows (a legacy row that is itself dangling or cross-workspace is reported, never repaired here).
 */
export async function assertEntityLinksSolutionKeyResultBackfill(client: PoolClient, schema: string) {
  const unmatched = await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorOf(schema)} WHERE ${unmatchedWhere}`)
  if (unmatched !== 0) throw refuse(`coverage postcondition failed: ${unmatched} consistent solution_key_result_links rows have no matching ${SOLUTION_KEY_RESULT_KEY} row`)

  // A mirror row whose legacy row is quarantined still HAS a counterpart (the pair exists), so this cannot fail on a kept row.
  const stale = await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         WHERE e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND NOT EXISTS (SELECT 1 FROM "${schema}"."solution_key_result_links" AS c WHERE c.solution_id = e.from_id AND c.key_result_id = e.to_id)`)
  if (stale !== 0) throw refuse(`staleness postcondition failed: ${stale} ${SOLUTION_KEY_RESULT_KEY} rows have no legacy counterpart`)

  const duplicates = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type = '${SOLUTION_KEY_RESULT_KEY}'
         GROUP BY from_id, link_type, to_id HAVING count(*) > 1
       ) AS dup`)
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)

  const unexplained = (predicate: string) => `SELECT count(*)::text AS n FROM ${mirrorRows(schema)}
         WHERE e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND (${predicate}) AND (l.id IS NULL OR (${classOf}) = 'ok')`
  const dangling = await count(client, unexplained("s.id IS NULL OR kr.id IS NULL OR obj.id IS NULL"))
  if (dangling !== 0) throw refuse(`integrity postcondition failed: ${dangling} ${SOLUTION_KEY_RESULT_KEY} rows have a missing endpoint that is not a reported quarantined row`)
  const mismatch = await count(client, unexplained("e.workspace_id IS DISTINCT FROM s.workspace_id OR e.workspace_id IS DISTINCT FROM obj.workspace_id"))
  if (mismatch !== 0) throw refuse(`tenant postcondition failed: ${mismatch} ${SOLUTION_KEY_RESULT_KEY} rows have a workspace_id that differs from an endpoint's`)
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type EntityLinksSolutionKeyResultStatus = {
  legacyLinks: number
  mirroredLinks: number
  /** Consistent legacy rows the backfill would still insert or repair. */
  unmatched: number
  /**
   * Mirror rows with no legacy counterpart. Until the receipt exists a re-POST prunes them; once it exists a re-POST is skipped (applied names
   * are not re-run), so a non-zero value after the receipt is post-receipt drift that needs a separately numbered residual migration.
   */
  staleMirrorRows: number
  quarantined: SolutionKeyResultQuarantine
  /** Mirror rows kept (not deleted) because their legacy row is quarantined. */
  mirrorRowsKeptForQuarantine: MirrorRowsKept
}

/** Counts and capped ids only (no titles or content). Throws if a table is missing; the caller turns that into an error field. */
export async function getEntityLinksSolutionKeyResultStatus(client: PoolClient, schema: string): Promise<EntityLinksSolutionKeyResultStatus> {
  return {
    legacyLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."solution_key_result_links"`),
    mirroredLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${SOLUTION_KEY_RESULT_KEY}'`),
    unmatched: await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorOf(schema)} WHERE ${unmatchedWhere}`),
    staleMirrorRows: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         LEFT JOIN "${schema}"."solution_key_result_links" AS counterpart ON counterpart.solution_id = e.from_id AND counterpart.key_result_id = e.to_id
         WHERE e.link_type = '${SOLUTION_KEY_RESULT_KEY}' AND counterpart.id IS NULL`),
    quarantined: await findQuarantinedSolutionKeyResultLinks(client, schema),
    mirrorRowsKeptForQuarantine: await findMirrorRowsKeptForQuarantine(client, schema),
  }
}
