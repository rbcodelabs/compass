import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of ADR phase 5 (Opportunity <-> Objective, and the Opportunity -> Key Result pointer) on the generic entity_links
 * table. No DDL: 091 created entity_links, 071 created opportunity_objective_links. Two sources, one migration:
 *
 *   OPPORTUNITY_TARGETS_OBJECTIVE   <- opportunity_objective_links   origin, source, created_by_id and created_at are COPIED
 *   OPPORTUNITY_TARGETS_KEY_RESULT  <- opportunities.linked_key_result_id   origin LEGACY, source MIGRATION
 *
 * The legacy table and the column stay the source of truth; this only fills the mirror that lib/links/legacy-mirror.ts keeps in
 * step from now on. EXPLICIT-ONLY: never part of an untargeted run; POST it by name after the mirroring code is deployed and the
 * COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR flag is on, so nothing slips in unmirrored while it runs.
 *
 * Per type, in this order, each step in committed batches of 500 (a link is 4 DSQL-modified rows, the cap is 3,000):
 *   1. prune  mirror rows that have no legacy counterpart (the pointer moved or the legacy row went while the flag was off); the counterpart is
 *             re-checked inside the DELETE itself, so a row that gained one meanwhile survives;
 *   2. repair mirror rows whose origin or workspace_id disagrees with the legacy row;
 *   3. insert the legacy rows that have no mirror row (anti-join; no ON CONFLICT, which is unproven against DSQL's async unique index).
 * Idempotent and resumable: a finished table selects nothing in any step.
 *
 * QUARANTINE. A legacy row is mirrored only when it is consistent: both endpoints exist, the Opportunity and the Objective share a
 * workspace (and so does the legacy link row), and its origin is DIRECT or LEGACY. Every other row is left exactly as it is, never
 * linked and never deleted, and REPORTED (counts plus capped ids in the POST log and in GET /api/admin/migrate). Who resolves a
 * quarantined row is a human decision outside this migration.
 *
 * Before the receipt the postconditions prove: zero unmatched non-quarantined legacy rows, zero duplicate pairs (and at most one
 * pointer row per opportunity), every mirror row's workspace_id equals both endpoints', and no mirror row has a missing endpoint
 * unless its legacy counterpart is one of the reported quarantined rows.
 *
 * A residual re-run migration (the 072 / 094 pattern) is NOT built here. If the dual-write code turns out to leave drift between
 * this migration and the read flip, register a DDL-free "096_..._residual" that calls the same two exported functions.
 */
export const ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION = "095_entity_links_backfill_opportunity"

export const OPPORTUNITY_OBJECTIVE_KEY = "OPPORTUNITY_TARGETS_OBJECTIVE"
export const OPPORTUNITY_KEY_RESULT_KEY = "OPPORTUNITY_TARGETS_KEY_RESULT"

/** DSQL caps a write transaction at 3,000 modified rows; each mirror row is the row plus 3 index entries. */
export const ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE = 500
/** How many quarantined ids the POST log and the GET status name per class. */
const REPORTED_ID_CAP = 50

type Sleep = (ms: number) => Promise<void>

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION}: ${message}`)

export type QuarantineClass = "dangling" | "crossWorkspace" | "linkWorkspaceDrift" | "invalidOrigin"

// ── SQL fragments (one place, so the backfill, the postconditions and the status cannot disagree) ──────────────────

/** Source A: every opportunity_objective_links row, with its endpoints (LEFT JOINs: a missing endpoint is a class, not a vanished row). */
const sourceA = (s: string) => `"${s}"."opportunity_objective_links" AS l
         LEFT JOIN "${s}"."opportunities" AS o ON o.id = l.opportunity_id
         LEFT JOIN "${s}"."objectives" AS obj ON obj.id = l.objective_id`

/** 'ok' = mirrorable; anything else is the quarantine class. First match wins. */
const classA = `CASE
           WHEN o.id IS NULL OR obj.id IS NULL THEN 'dangling'
           WHEN o.workspace_id IS NULL OR obj.workspace_id IS NULL OR o.workspace_id <> obj.workspace_id THEN 'crossWorkspace'
           WHEN l.workspace_id <> o.workspace_id THEN 'linkWorkspaceDrift'
           WHEN l.origin NOT IN ('DIRECT', 'LEGACY') THEN 'invalidOrigin'
           ELSE 'ok' END`

/** Source B: every opportunity that carries a pointer, with the Key Result and its Objective. */
const sourceB = (s: string) => `"${s}"."opportunities" AS o
         LEFT JOIN "${s}"."key_results" AS kr ON kr.id = o.linked_key_result_id
         LEFT JOIN "${s}"."objectives" AS obj ON obj.id = kr.objective_id`

const classB = `CASE
           WHEN kr.id IS NULL OR obj.id IS NULL THEN 'dangling'
           WHEN obj.workspace_id IS NULL OR o.workspace_id <> obj.workspace_id THEN 'crossWorkspace'
           ELSE 'ok' END`

/** Mirror row of a source-A pair, matched on the unique pair (from_id, link_type, to_id). */
const mirrorOfA = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = l.opportunity_id AND e.link_type = '${OPPORTUNITY_OBJECTIVE_KEY}' AND e.to_id = l.objective_id`
const mirrorOfB = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = o.id AND e.link_type = '${OPPORTUNITY_KEY_RESULT_KEY}' AND e.to_id = o.linked_key_result_id`

// ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fail closed, before any write: 071 (legacy table), 091 (entity_links) and 068 (objectives.workspace_id) must be complete. */
export async function assertEntityLinksOpportunityPreconditions(client: PoolClient, schema: string) {
  for (const required of ["068_workspace_id_on_solution_objective", "071_typed_link_tables", "091_entity_links"]) {
    const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [required])
    if (receipt === 0) throw refuse(`precondition failed: ${required} is not applied. Apply it first; nothing was changed.`)
  }
  const present = await client.query<{ table_name: string }>(
    "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'objectives' AND column_name = 'workspace_id') OR (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'opportunity_objective_links' AND column_name = 'origin'))",
    [schema],
  )
  if (present.rows.length !== 3) throw refuse("precondition failed: objectives.workspace_id, entity_links or opportunity_objective_links is missing. Nothing was changed.")
}

// ── Batched steps ──────────────────────────────────────────────────────────────────────────────────────────────────

type BatchResult = { rows: { id: string }[] }

/**
 * Selects a batch and applies it until the select is empty. A batch that selected rows but changed none would loop forever, so it throws,
 * except `tolerateStalls` times in a row (a concurrent writer can legitimately make a selected row no longer qualify; the re-select then excludes it).
 */
async function drain(label: string, select: () => Promise<BatchResult["rows"]>, apply: (ids: string[]) => Promise<number>, tolerateStalls = 0): Promise<number> {
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

/** True when `existsSql` (a SELECT correlated on alias e) finds no legacy counterpart. Used in BOTH the select and the DELETE, so a row that gained one in between survives. */
async function pruneStaleMirrorRows(client: PoolClient, schema: string, key: string, counterpartSql: string, sleep?: Sleep): Promise<number> {
  const stale = `e.link_type = '${key}' AND NOT EXISTS (${counterpartSql})`
  return drain(
    `prune ${key}`,
    async () => (await client.query<{ id: string }>(`SELECT e.id AS id FROM "${schema}"."entity_links" AS e WHERE ${stale} LIMIT $1`, [ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE])).rows,
    async (ids) =>
      (await withOccRetry(() => client.query(`DELETE FROM "${schema}"."entity_links" AS e WHERE e.id = ANY($1::uuid[]) AND ${stale}`, [ids]), sleep)).rowCount ?? 0,
    3,
  )
}

async function repairDriftedMirrorRows(client: PoolClient, schema: string, kind: "A" | "B", sleep?: Sleep): Promise<number> {
  const from = kind === "A" ? sourceA(schema) : sourceB(schema)
  const join = kind === "A" ? mirrorOfA(schema) : mirrorOfB(schema)
  const cls = kind === "A" ? classA : classB
  const origin = kind === "A" ? "l.origin" : "'LEGACY'"
  const workspace = kind === "A" ? "l.workspace_id" : "o.workspace_id"
  let repaired = 0
  while (true) {
    const batch = await client.query<{ id: string; origin: string; workspace_id: string }>(
      `SELECT e.id AS id, ${origin} AS origin, ${workspace} AS workspace_id
         FROM ${from} ${join}
         WHERE e.id IS NOT NULL AND ${kind === "B" ? "o.linked_key_result_id IS NOT NULL AND " : ""}(${cls}) = 'ok'
           AND (e.origin <> ${origin} OR e.workspace_id <> ${workspace})
         LIMIT $1`,
      [ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return repaired
    // One plain UPDATE per (origin, workspace_id) group: no multi-array unnest, which is not proven on DSQL.
    const groups = new Map<string, { origin: string; workspace_id: string; ids: string[] }>()
    for (const row of batch.rows) {
      const group = groups.get(`${row.origin}|${row.workspace_id}`) ?? { origin: row.origin, workspace_id: row.workspace_id, ids: [] }
      group.ids.push(row.id)
      groups.set(`${row.origin}|${row.workspace_id}`, group)
    }
    let changed = 0
    for (const group of groups.values()) {
      const result = await withOccRetry(
        () => client.query(
          `UPDATE "${schema}"."entity_links" SET origin = $1, workspace_id = $2::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($3::uuid[])`,
          [group.origin, group.workspace_id, group.ids],
        ),
        sleep,
      )
      changed += result.rowCount ?? 0
    }
    const result = { rowCount: changed }
    if (changed === 0) throw refuse(`repair ${kind === "A" ? OPPORTUNITY_OBJECTIVE_KEY : OPPORTUNITY_KEY_RESULT_KEY} made no progress on ${batch.rows.length} selected rows`)
    repaired += result.rowCount ?? 0
  }
}

async function insertMissingMirrorRows(client: PoolClient, schema: string, kind: "A" | "B", sleep?: Sleep): Promise<number> {
  let inserted = 0
  let uniqueRaces = 0
  while (true) {
    // Select the ids, then copy the columns in SQL (INSERT ... SELECT), so timestamps never round-trip through the driver.
    const batch = await client.query<{ id: string }>(
      kind === "A"
        ? `SELECT l.id AS id FROM ${sourceA(schema)} ${mirrorOfA(schema)} WHERE e.id IS NULL AND (${classA}) = 'ok' LIMIT $1`
        : `SELECT o.id AS id FROM ${sourceB(schema)} ${mirrorOfB(schema)} WHERE o.linked_key_result_id IS NOT NULL AND e.id IS NULL AND (${classB}) = 'ok' LIMIT $1`,
      [ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return inserted
    const ids = batch.rows.map((row) => row.id)
    let result: { rowCount: number | null }
    try {
      result = await withOccRetry(
      () => client.query(
        kind === "A"
          ? `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
             SELECT l.workspace_id, '${OPPORTUNITY_OBJECTIVE_KEY}', 'OPPORTUNITY', l.opportunity_id, 'OBJECTIVE', l.objective_id, l.origin, l.source, l.created_by_id, l.created_at, CURRENT_TIMESTAMP
             FROM "${schema}"."opportunity_objective_links" AS l WHERE l.id = ANY($1::uuid[])`
          : `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
             SELECT o.workspace_id, '${OPPORTUNITY_KEY_RESULT_KEY}', 'OPPORTUNITY', o.id, 'KEY_RESULT', o.linked_key_result_id, 'LEGACY', 'MIGRATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             FROM "${schema}"."opportunities" AS o WHERE o.id = ANY($1::uuid[]) AND o.linked_key_result_id IS NOT NULL`,
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
    // A selected row that cannot be inserted (its legacy row vanished in between) is simply re-selected; no rows at all would loop forever.
    if ((result.rowCount ?? 0) === 0 && ids.length > 0) {
      const again = await client.query<{ id: string }>(
        kind === "A"
          ? `SELECT l.id AS id FROM "${schema}"."opportunity_objective_links" AS l WHERE l.id = ANY($1::uuid[])`
          : `SELECT o.id AS id FROM "${schema}"."opportunities" AS o WHERE o.id = ANY($1::uuid[]) AND o.linked_key_result_id IS NOT NULL`,
        [ids],
      )
      if (again.rows.length > 0) throw refuse(`insert ${kind === "A" ? OPPORTUNITY_OBJECTIVE_KEY : OPPORTUNITY_KEY_RESULT_KEY} made no progress on ${ids.length} selected rows`)
    }
    inserted += result.rowCount ?? 0
  }
}

export type OpportunityLinksQuarantine = Record<"objectiveLinks" | "keyResultPointers", Record<QuarantineClass, { count: number; ids: string[] }>>

const CLASSES: readonly QuarantineClass[] = ["dangling", "crossWorkspace", "linkWorkspaceDrift", "invalidOrigin"]

/**
 * The legacy rows that are NOT mirrored, by class, with up to REPORTED_ID_CAP ids each (objectiveLinks: opportunity_objective_links.id;
 * keyResultPointers: opportunities.id). Read-only; used by the POST log, the postconditions and GET /api/admin/migrate.
 */
export async function findQuarantinedOpportunityLinks(client: PoolClient, schema: string): Promise<OpportunityLinksQuarantine> {
  const empty = () => Object.fromEntries(CLASSES.map((c) => [c, { count: 0, ids: [] as string[] }])) as Record<QuarantineClass, { count: number; ids: string[] }>
  const out: OpportunityLinksQuarantine = { objectiveLinks: empty(), keyResultPointers: empty() }
  for (const cls of CLASSES) {
    out.objectiveLinks[cls].count = await count(client, `SELECT count(*)::text AS n FROM ${sourceA(schema)} WHERE (${classA}) = $1`, [cls])
    out.keyResultPointers[cls].count = await count(client, `SELECT count(*)::text AS n FROM ${sourceB(schema)} WHERE o.linked_key_result_id IS NOT NULL AND (${classB}) = $1`, [cls])
    if (out.objectiveLinks[cls].count > 0) {
      out.objectiveLinks[cls].ids = (await client.query<{ id: string }>(`SELECT l.id AS id FROM ${sourceA(schema)} WHERE (${classA}) = $1 ORDER BY l.id LIMIT ${REPORTED_ID_CAP}`, [cls])).rows.map((r) => r.id)
    }
    if (out.keyResultPointers[cls].count > 0) {
      out.keyResultPointers[cls].ids = (await client.query<{ id: string }>(`SELECT o.id AS id FROM ${sourceB(schema)} WHERE o.linked_key_result_id IS NOT NULL AND (${classB}) = $1 ORDER BY o.id LIMIT ${REPORTED_ID_CAP}`, [cls])).rows.map((r) => r.id)
    }
  }
  return out
}

function logQuarantine(log: string[], quarantine: OpportunityLinksQuarantine) {
  for (const [source, unit] of [["objectiveLinks", "opportunity_objective_links ids"], ["keyResultPointers", "opportunity ids with a linked_key_result_id"]] as const) {
    for (const cls of CLASSES) {
      const entry = quarantine[source][cls]
      if (entry.count === 0) continue
      const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
      log.push(`  ! quarantined ${entry.count} ${source} row(s) of class ${cls}, left unlinked and untouched (${unit}): ${entry.ids.join(", ")}${more}`)
    }
  }
}

/**
 * Backfills both types. Idempotent and resumable (see the file comment). Returns what it did so the caller and the tests can assert on it.
 */
export async function backfillEntityLinksOpportunity(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ pruned: number; repaired: number; inserted: number; quarantined: OpportunityLinksQuarantine; keptMirrorRows: MirrorRowsKept }> {
  await assertEntityLinksOpportunityPreconditions(client, schema)

  const prunedA = await pruneStaleMirrorRows(client, schema, OPPORTUNITY_OBJECTIVE_KEY,
    `SELECT 1 FROM "${schema}"."opportunity_objective_links" AS c WHERE c.opportunity_id = e.from_id AND c.objective_id = e.to_id`, sleep)
  const prunedB = await pruneStaleMirrorRows(client, schema, OPPORTUNITY_KEY_RESULT_KEY,
    `SELECT 1 FROM "${schema}"."opportunities" AS c WHERE c.id = e.from_id AND c.linked_key_result_id = e.to_id`, sleep)
  const repairedA = await repairDriftedMirrorRows(client, schema, "A", sleep)
  const repairedB = await repairDriftedMirrorRows(client, schema, "B", sleep)
  const insertedA = await insertMissingMirrorRows(client, schema, "A", sleep)
  const insertedB = await insertMissingMirrorRows(client, schema, "B", sleep)
  log.push(`  ✓ ${OPPORTUNITY_OBJECTIVE_KEY}: inserted ${insertedA}, repaired ${repairedA}, pruned ${prunedA} stale mirror rows`)
  log.push(`  ✓ ${OPPORTUNITY_KEY_RESULT_KEY}: inserted ${insertedB}, repaired ${repairedB}, pruned ${prunedB} stale mirror rows`)

  const quarantined = await findQuarantinedOpportunityLinks(client, schema)
  logQuarantine(log, quarantined)
  const keptMirrorRows = await findMirrorRowsKeptForQuarantine(client, schema)
  for (const source of ["objectiveLinks", "keyResultPointers"] as const) {
    const entry = keptMirrorRows[source]
    if (entry.count === 0) continue
    const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
    log.push(`  ! kept ${entry.count} ${source} mirror row(s) whose legacy row is quarantined, not deleted (entity_links ids): ${entry.ids.join(", ")}${more}`)
  }
  return { pruned: prunedA + prunedB, repaired: repairedA + repairedB, inserted: insertedA + insertedB, quarantined, keptMirrorRows }
}

// ── Postconditions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirror rows of A with their endpoints and legacy counterpart; the predicate picks the bad ones that are NOT explained by a quarantined legacy row. */
const mirrorRowsA = (s: string) => `"${s}"."entity_links" AS e
         LEFT JOIN "${s}"."opportunities" AS o ON o.id = e.from_id
         LEFT JOIN "${s}"."objectives" AS obj ON obj.id = e.to_id
         LEFT JOIN "${s}"."opportunity_objective_links" AS l ON l.opportunity_id = e.from_id AND l.objective_id = e.to_id`

const mirrorRowsB = (s: string) => `"${s}"."entity_links" AS e
         LEFT JOIN "${s}"."opportunities" AS o ON o.id = e.from_id AND o.linked_key_result_id = e.to_id
         LEFT JOIN "${s}"."key_results" AS kr ON kr.id = e.to_id
         LEFT JOIN "${s}"."objectives" AS obj ON obj.id = kr.objective_id`

export type MirrorRowsKept = Record<"objectiveLinks" | "keyResultPointers", { count: number; ids: string[] }>

/**
 * Mirror rows (entity_links.id) whose legacy counterpart exists but is one of the quarantined rows, for example an endpoint deleted after the
 * mirror row was written and the legacy row not yet cleaned up. They are KEPT (never deleted here) and reported; the postconditions allow
 * them only because they are listed. Read-only.
 */
export async function findMirrorRowsKeptForQuarantine(client: PoolClient, schema: string): Promise<MirrorRowsKept> {
  const kept = async (from: string, where: string) => ({
    count: await count(client, `SELECT count(*)::text AS n FROM ${from} WHERE ${where}`),
    ids: (await client.query<{ id: string }>(`SELECT e.id AS id FROM ${from} WHERE ${where} ORDER BY e.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((row) => row.id),
  })
  return {
    objectiveLinks: await kept(mirrorRowsA(schema), `e.link_type = '${OPPORTUNITY_OBJECTIVE_KEY}' AND l.id IS NOT NULL AND (${classA}) <> 'ok'`),
    keyResultPointers: await kept(mirrorRowsB(schema), `e.link_type = '${OPPORTUNITY_KEY_RESULT_KEY}' AND o.id IS NOT NULL AND (${classB}) <> 'ok'`),
  }
}

/**
 * All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes):
 *   1. no consistent legacy row lacks its mirror row (origin and workspace_id included);
 *   2. no duplicate (from, type, to) pair, and no opportunity has two pointer rows;
 *   3. every mirror row's workspace_id equals both endpoints', and no endpoint is missing, except where the legacy counterpart is one of
 *      the reported quarantined rows (a legacy row that is itself dangling or cross-workspace is reported, never repaired here).
 */
export async function assertEntityLinksOpportunityBackfill(client: PoolClient, schema: string) {
  const unmatchedA = await count(client, `SELECT count(*)::text AS n FROM ${sourceA(schema)} ${mirrorOfA(schema)}
         WHERE (${classA}) = 'ok' AND (e.id IS NULL OR e.origin <> l.origin OR e.workspace_id <> l.workspace_id)`)
  if (unmatchedA !== 0) throw refuse(`coverage postcondition failed: ${unmatchedA} consistent opportunity_objective_links rows have no matching ${OPPORTUNITY_OBJECTIVE_KEY} row`)
  const unmatchedB = await count(client, `SELECT count(*)::text AS n FROM ${sourceB(schema)} ${mirrorOfB(schema)}
         WHERE o.linked_key_result_id IS NOT NULL AND (${classB}) = 'ok' AND (e.id IS NULL OR e.origin <> 'LEGACY' OR e.workspace_id <> o.workspace_id)`)
  if (unmatchedB !== 0) throw refuse(`coverage postcondition failed: ${unmatchedB} consistent linked_key_result_id pointers have no matching ${OPPORTUNITY_KEY_RESULT_KEY} row`)

  const duplicates = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type IN ('${OPPORTUNITY_OBJECTIVE_KEY}', '${OPPORTUNITY_KEY_RESULT_KEY}')
         GROUP BY from_id, link_type, to_id HAVING count(*) > 1
       ) AS dup`)
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)
  const multiPointer = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type = '${OPPORTUNITY_KEY_RESULT_KEY}' GROUP BY from_id HAVING count(*) > 1
       ) AS multi`)
  if (multiPointer !== 0) throw refuse(`cardinality postcondition failed: ${multiPointer} opportunities have more than one ${OPPORTUNITY_KEY_RESULT_KEY} row`)

  const unexplainedA = (predicate: string) => `SELECT count(*)::text AS n FROM ${mirrorRowsA(schema)}
         WHERE e.link_type = '${OPPORTUNITY_OBJECTIVE_KEY}' AND (${predicate}) AND (l.id IS NULL OR (${classA}) = 'ok')`
  const unexplainedB = (predicate: string) => `SELECT count(*)::text AS n FROM ${mirrorRowsB(schema)}
         WHERE e.link_type = '${OPPORTUNITY_KEY_RESULT_KEY}' AND (${predicate}) AND (o.id IS NULL OR (${classB}) = 'ok')`
  const danglingA = await count(client, unexplainedA("o.id IS NULL OR obj.id IS NULL"))
  const danglingB = await count(client, unexplainedB("o.id IS NULL OR kr.id IS NULL OR obj.id IS NULL"))
  if (danglingA + danglingB !== 0) throw refuse(`integrity postcondition failed: ${danglingA} ${OPPORTUNITY_OBJECTIVE_KEY} and ${danglingB} ${OPPORTUNITY_KEY_RESULT_KEY} rows have a missing endpoint that is not a reported quarantined row`)
  const mismatchA = await count(client, unexplainedA("e.workspace_id IS DISTINCT FROM o.workspace_id OR e.workspace_id IS DISTINCT FROM obj.workspace_id"))
  const mismatchB = await count(client, unexplainedB("e.workspace_id IS DISTINCT FROM o.workspace_id OR e.workspace_id IS DISTINCT FROM obj.workspace_id"))
  if (mismatchA + mismatchB !== 0) throw refuse(`tenant postcondition failed: ${mismatchA} ${OPPORTUNITY_OBJECTIVE_KEY} and ${mismatchB} ${OPPORTUNITY_KEY_RESULT_KEY} rows have a workspace_id that differs from an endpoint's`)
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type EntityLinksOpportunityStatus = {
  legacyObjectiveLinks: number
  legacyObjectiveLinksByOrigin: Record<string, number>
  pointersSet: number
  mirroredObjectiveLinks: number
  mirroredKeyResultPointers: number
  /** Consistent legacy rows the backfill would still insert or repair. */
  unmatched: { objectiveLinks: number; keyResultPointers: number }
  /** Mirror rows with no legacy counterpart; a re-POST prunes them. */
  staleMirrorRows: { objectiveLinks: number; keyResultPointers: number }
  quarantined: OpportunityLinksQuarantine
  /** Mirror rows kept (not deleted) because their legacy row is quarantined. */
  mirrorRowsKeptForQuarantine: MirrorRowsKept
}

/** Counts and capped ids only (no titles or content). Throws if a table is missing; the caller turns that into an error field. */
export async function getEntityLinksOpportunityStatus(client: PoolClient, schema: string): Promise<EntityLinksOpportunityStatus> {
  const byOrigin = await client.query<{ origin: string; n: string }>(`SELECT origin, count(*)::text AS n FROM "${schema}"."opportunity_objective_links" GROUP BY origin`)
  return {
    legacyObjectiveLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."opportunity_objective_links"`),
    legacyObjectiveLinksByOrigin: Object.fromEntries(byOrigin.rows.map((row) => [row.origin, num(row.n)])),
    pointersSet: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."opportunities" WHERE linked_key_result_id IS NOT NULL`),
    mirroredObjectiveLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${OPPORTUNITY_OBJECTIVE_KEY}'`),
    mirroredKeyResultPointers: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${OPPORTUNITY_KEY_RESULT_KEY}'`),
    unmatched: {
      objectiveLinks: await count(client, `SELECT count(*)::text AS n FROM ${sourceA(schema)} ${mirrorOfA(schema)}
         WHERE (${classA}) = 'ok' AND (e.id IS NULL OR e.origin <> l.origin OR e.workspace_id <> l.workspace_id)`),
      keyResultPointers: await count(client, `SELECT count(*)::text AS n FROM ${sourceB(schema)} ${mirrorOfB(schema)}
         WHERE o.linked_key_result_id IS NOT NULL AND (${classB}) = 'ok' AND (e.id IS NULL OR e.origin <> 'LEGACY' OR e.workspace_id <> o.workspace_id)`),
    },
    staleMirrorRows: {
      objectiveLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         LEFT JOIN "${schema}"."opportunity_objective_links" AS counterpart ON counterpart.opportunity_id = e.from_id AND counterpart.objective_id = e.to_id
         WHERE e.link_type = '${OPPORTUNITY_OBJECTIVE_KEY}' AND counterpart.id IS NULL`),
      keyResultPointers: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         LEFT JOIN "${schema}"."opportunities" AS counterpart ON counterpart.id = e.from_id AND counterpart.linked_key_result_id = e.to_id
         WHERE e.link_type = '${OPPORTUNITY_KEY_RESULT_KEY}' AND counterpart.id IS NULL`),
    },
    quarantined: await findQuarantinedOpportunityLinks(client, schema),
    mirrorRowsKeptForQuarantine: await findMirrorRowsKeptForQuarantine(client, schema),
  }
}
