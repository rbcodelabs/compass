import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of ADR phase 6 (ArtifactLink) on the generic entity_links table. No DDL: 091 created entity_links, 034 created artifact_links.
 * One source, two registry types, split by artifact_links.linked_type:
 *
 *   ARTIFACT_ATTACHED_TO_SOLUTION  <- artifact_links WHERE linked_type = 'SOLUTION'
 *   ARTIFACT_SUPPORTS_DECISION     <- artifact_links WHERE linked_type = 'REVIEW_REQUEST' (TRACKED_DECISION requests only; live supporting material, ADR-0010)
 *
 * source, created_by_id and created_at are COPIED; origin is DIRECT (artifact links are never derived).
 *
 * The legacy table stays the source of truth; this only fills the mirror that lib/links/legacy-mirror.ts keeps in step from now on.
 * EXPLICIT-ONLY: never part of an untargeted run; POST it by name after the mirroring code is deployed and the
 * COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR flag is on, so nothing slips in unmirrored while it runs.
 *
 * In this order, each step in committed batches of 500 (a link is 4 DSQL-modified rows, the cap is 3,000):
 *   1. prune  mirror rows that have no legacy counterpart (the legacy row went while the flag was off); the counterpart is re-checked
 *             inside the DELETE itself, so a row that gained one meanwhile survives;
 *   2. repair mirror rows whose origin or workspace_id disagrees with the legacy row;
 *   3. insert the legacy rows that have no mirror row (anti-join; no ON CONFLICT, which is unproven against DSQL's async unique index).
 * Idempotent and resumable: a finished table selects nothing in any step.
 *
 * QUARANTINE. A legacy row is mirrored only when it is consistent: linked_type is SOLUTION or REVIEW_REQUEST, the Artifact and the target exist,
 * they share a workspace (and so does the legacy link row), and a Decision target is a TRACKED_DECISION request. Every other row is left
 * exactly as it is, never linked and never deleted, and REPORTED (counts plus capped ids in the POST log and in GET /api/admin/migrate).
 * Who resolves a quarantined row is a human decision outside this migration. A mirror row whose legacy row is quarantined is KEPT and reported too.
 *
 * Before the receipt the postconditions prove: zero unmatched non-quarantined legacy rows, zero duplicate pairs, every mirror row's
 * workspace_id equals both endpoints', and no mirror row has a missing endpoint unless its legacy counterpart is one of the reported
 * quarantined rows.
 *
 * A residual re-run migration (the 072 / 094 pattern) is NOT built here. The runner never re-runs an applied migration, so drift left after
 * the receipt needs a separately numbered, DDL-free, explicit-only residual that calls the same two exported functions
 * (see 106_entity_links_residual_opportunity).
 */
export const ENTITY_LINKS_ARTIFACT_BACKFILL_MIGRATION = "096_entity_links_backfill_artifact"

export const ARTIFACT_SOLUTION_KEY = "ARTIFACT_ATTACHED_TO_SOLUTION"
export const ARTIFACT_DECISION_KEY = "ARTIFACT_SUPPORTS_DECISION"
const KEYS = [ARTIFACT_SOLUTION_KEY, ARTIFACT_DECISION_KEY] as const

/** DSQL caps a write transaction at 3,000 modified rows; each mirror row is the row plus 3 index entries. */
export const ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE = 500
/** How many quarantined ids the POST log and the GET status name per class. */
const REPORTED_ID_CAP = 50

type Sleep = (ms: number) => Promise<void>

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_ARTIFACT_BACKFILL_MIGRATION}: ${message}`)

export type QuarantineClass = "invalidType" | "dangling" | "crossWorkspace" | "linkWorkspaceDrift" | "notTrackedDecision"
const CLASSES: readonly QuarantineClass[] = ["invalidType", "dangling", "crossWorkspace", "linkWorkspaceDrift", "notTrackedDecision"]

// ── SQL fragments (one place, so the backfill, the postconditions and the status cannot disagree) ──────────────────

/** Every artifact_links row with its Artifact and its target (LEFT JOINs: a missing endpoint is a class, not a vanished row). */
const source = (s: string) => `"${s}"."artifact_links" AS l
         LEFT JOIN "${s}"."artifacts" AS a ON a.id = l.artifact_id
         LEFT JOIN "${s}"."solutions" AS sol ON l.linked_type = 'SOLUTION' AND sol.id = l.linked_id
         LEFT JOIN "${s}"."review_requests" AS r ON l.linked_type = 'REVIEW_REQUEST' AND r.id = l.linked_id`

const targetWorkspace = "COALESCE(sol.workspace_id, r.workspace_id)"

/** 'ok' = mirrorable; anything else is the quarantine class. First match wins. */
const classOf = `CASE
           WHEN l.linked_type NOT IN ('SOLUTION', 'REVIEW_REQUEST') THEN 'invalidType'
           WHEN a.id IS NULL OR (sol.id IS NULL AND r.id IS NULL) THEN 'dangling'
           WHEN ${targetWorkspace} IS NULL OR a.workspace_id <> ${targetWorkspace} THEN 'crossWorkspace'
           WHEN l.workspace_id <> a.workspace_id THEN 'linkWorkspaceDrift'
           WHEN r.id IS NOT NULL AND r.gate_type <> 'TRACKED_DECISION' THEN 'notTrackedDecision'
           ELSE 'ok' END`

const keyOf = `CASE WHEN l.linked_type = 'SOLUTION' THEN '${ARTIFACT_SOLUTION_KEY}' ELSE '${ARTIFACT_DECISION_KEY}' END`

/** Mirror row of a legacy row, matched on the unique pair (from_id, link_type, to_id). */
const mirrorOf = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = l.artifact_id AND e.link_type = ${keyOf} AND e.to_id = l.linked_id`

/** A consistent legacy row has no mirror row, or one that disagrees on origin or workspace. */
const unmatchedWhere = `(${classOf}) = 'ok' AND (e.id IS NULL OR e.origin <> 'DIRECT' OR e.workspace_id <> l.workspace_id)`

// ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fail closed, before any write: 034 (artifact_links), 068 (solutions.workspace_id) and 091 (entity_links) must be complete. */
export async function assertEntityLinksArtifactPreconditions(client: PoolClient, schema: string) {
  for (const required of ["034_artifacts", "068_workspace_id_on_solution_objective", "091_entity_links"]) {
    const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [required])
    if (receipt === 0) throw refuse(`precondition failed: ${required} is not applied. Apply it first; nothing was changed.`)
  }
  const present = await client.query<{ table_name: string }>(
    "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'solutions' AND column_name = 'workspace_id') OR (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'artifact_links' AND column_name = 'linked_type') OR (table_name = 'review_requests' AND column_name = 'gate_type'))",
    [schema],
  )
  if (present.rows.length !== 4) throw refuse("precondition failed: solutions.workspace_id, entity_links, artifact_links or review_requests.gate_type is missing. Nothing was changed.")
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

/** The counterpart is re-checked in BOTH the select and the DELETE, so a row that gained one in between survives. */
async function pruneStaleMirrorRows(client: PoolClient, schema: string, key: string, linkedType: string, sleep?: Sleep): Promise<number> {
  const stale = `e.link_type = '${key}' AND NOT EXISTS (SELECT 1 FROM "${schema}"."artifact_links" AS c WHERE c.artifact_id = e.from_id AND c.linked_id = e.to_id AND c.linked_type = '${linkedType}')`
  return drain(
    `prune ${key}`,
    async () => (await client.query<{ id: string }>(`SELECT e.id AS id FROM "${schema}"."entity_links" AS e WHERE ${stale} LIMIT $1`, [ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE])).rows,
    async (ids) =>
      (await withOccRetry(() => client.query(`DELETE FROM "${schema}"."entity_links" AS e WHERE e.id = ANY($1::uuid[]) AND ${stale}`, [ids]), sleep)).rowCount ?? 0,
    3,
  )
}

async function repairDriftedMirrorRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  let repaired = 0
  let stalls = 0
  while (true) {
    const batch = await client.query<{ id: string; workspace_id: string }>(
      `SELECT e.id AS id, l.workspace_id AS workspace_id
         FROM ${source(schema)} ${mirrorOf(schema)}
         WHERE e.id IS NOT NULL AND (${classOf}) = 'ok' AND (e.origin <> 'DIRECT' OR e.workspace_id <> l.workspace_id)
         LIMIT $1`,
      [ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return repaired
    // One plain UPDATE per workspace_id group: no multi-array unnest, which is not proven on DSQL. Origin is always DIRECT here.
    const groups = new Map<string, string[]>()
    for (const row of batch.rows) groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row.id])
    let changed = 0
    for (const [workspaceId, ids] of groups) {
      const result = await withOccRetry(
        () => client.query(`UPDATE "${schema}"."entity_links" SET origin = 'DIRECT', workspace_id = $1::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::uuid[])`, [workspaceId, ids]),
        sleep,
      )
      changed += result.rowCount ?? 0
    }
    if (changed === 0) {
      // Same tolerance as drain(): a concurrent writer can make selected rows stop qualifying; the re-select then excludes them.
      stalls += 1
      if (stalls > 3) throw refuse(`repair made no progress on ${batch.rows.length} selected rows`)
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
    const batch = await client.query<{ id: string }>(
      `SELECT l.id AS id FROM ${source(schema)} ${mirrorOf(schema)} WHERE e.id IS NULL AND (${classOf}) = 'ok' LIMIT $1`,
      [ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) return inserted
    const ids = batch.rows.map((row) => row.id)
    let result: { rowCount: number | null }
    try {
      result = await withOccRetry(
        () => client.query(
          `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
           SELECT l.workspace_id, ${keyOf}, 'ARTIFACT', l.artifact_id, l.linked_type, l.linked_id, 'DIRECT', l.source, l.created_by_id, l.created_at, CURRENT_TIMESTAMP
           FROM "${schema}"."artifact_links" AS l WHERE l.id = ANY($1::uuid[])`,
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
      const again = await client.query<{ id: string }>(`SELECT l.id AS id FROM "${schema}"."artifact_links" AS l WHERE l.id = ANY($1::uuid[])`, [ids])
      if (again.rows.length > 0) throw refuse(`insert made no progress on ${ids.length} selected rows`)
    }
    inserted += result.rowCount ?? 0
  }
}

export type ArtifactLinksQuarantine = Record<QuarantineClass, { count: number; ids: string[] }>

/**
 * The legacy rows that are NOT mirrored, by class, with up to REPORTED_ID_CAP artifact_links ids each.
 * Read-only; used by the POST log, the postconditions and GET /api/admin/migrate.
 */
export async function findQuarantinedArtifactLinks(client: PoolClient, schema: string): Promise<ArtifactLinksQuarantine> {
  const out = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, ids: [] as string[] }])) as ArtifactLinksQuarantine
  for (const cls of CLASSES) {
    out[cls].count = await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} WHERE (${classOf}) = $1`, [cls])
    if (out[cls].count > 0) {
      out[cls].ids = (await client.query<{ id: string }>(`SELECT l.id AS id FROM ${source(schema)} WHERE (${classOf}) = $1 ORDER BY l.id LIMIT ${REPORTED_ID_CAP}`, [cls])).rows.map((r) => r.id)
    }
  }
  return out
}

function logQuarantine(log: string[], quarantine: ArtifactLinksQuarantine) {
  for (const cls of CLASSES) {
    const entry = quarantine[cls]
    if (entry.count === 0) continue
    const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
    log.push(`  ! quarantined ${entry.count} artifact_links row(s) of class ${cls}, left unlinked and untouched (artifact_links ids): ${entry.ids.join(", ")}${more}`)
  }
}

/** Backfills both types. Idempotent and resumable (see the file comment). Returns what it did so the caller and the tests can assert on it. */
export async function backfillEntityLinksArtifact(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ pruned: number; repaired: number; inserted: number; quarantined: ArtifactLinksQuarantine; keptMirrorRows: MirrorRowsKept }> {
  await assertEntityLinksArtifactPreconditions(client, schema)

  const pruned = (await pruneStaleMirrorRows(client, schema, ARTIFACT_SOLUTION_KEY, "SOLUTION", sleep)) + (await pruneStaleMirrorRows(client, schema, ARTIFACT_DECISION_KEY, "REVIEW_REQUEST", sleep))
  const repaired = await repairDriftedMirrorRows(client, schema, sleep)
  const inserted = await insertMissingMirrorRows(client, schema, sleep)
  log.push(`  ✓ ${KEYS.join(" + ")}: inserted ${inserted}, repaired ${repaired}, pruned ${pruned} stale mirror rows`)

  const quarantined = await findQuarantinedArtifactLinks(client, schema)
  logQuarantine(log, quarantined)
  const keptMirrorRows = await findMirrorRowsKeptForQuarantine(client, schema)
  if (keptMirrorRows.count > 0) {
    const more = keptMirrorRows.count > keptMirrorRows.ids.length ? ` … and ${keptMirrorRows.count - keptMirrorRows.ids.length} more` : ""
    log.push(`  ! kept ${keptMirrorRows.count} mirror row(s) whose legacy row is quarantined, not deleted (entity_links ids): ${keptMirrorRows.ids.join(", ")}${more}`)
  }
  return { pruned, repaired, inserted, quarantined, keptMirrorRows }
}

// ── Postconditions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirror rows with their endpoints and legacy counterpart; the predicate picks the bad ones that are NOT explained by a quarantined legacy row. */
const mirrorRows = (s: string) => `"${s}"."entity_links" AS e
         LEFT JOIN "${s}"."artifacts" AS a ON a.id = e.from_id
         LEFT JOIN "${s}"."solutions" AS sol ON e.link_type = '${ARTIFACT_SOLUTION_KEY}' AND sol.id = e.to_id
         LEFT JOIN "${s}"."review_requests" AS r ON e.link_type = '${ARTIFACT_DECISION_KEY}' AND r.id = e.to_id
         LEFT JOIN "${s}"."artifact_links" AS l ON l.artifact_id = e.from_id AND l.linked_id = e.to_id AND l.linked_type = e.to_type`

const ourMirrorRows = `e.link_type IN ('${ARTIFACT_SOLUTION_KEY}', '${ARTIFACT_DECISION_KEY}')`

export type MirrorRowsKept = { count: number; ids: string[] }

/**
 * Mirror rows (entity_links.id) whose legacy counterpart exists but is one of the quarantined rows, for example an endpoint deleted after the
 * mirror row was written and the legacy row not yet cleaned up. They are KEPT (never deleted here) and reported; the postconditions allow
 * them only because they are listed. Read-only.
 */
export async function findMirrorRowsKeptForQuarantine(client: PoolClient, schema: string): Promise<MirrorRowsKept> {
  const from = mirrorRows(schema)
  const where = `${ourMirrorRows} AND l.id IS NOT NULL AND (${classOf}) <> 'ok'`
  return {
    count: await count(client, `SELECT count(*)::text AS n FROM ${from} WHERE ${where}`),
    ids: (await client.query<{ id: string }>(`SELECT e.id AS id FROM ${from} WHERE ${where} ORDER BY e.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((row) => row.id),
  }
}

/**
 * All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes):
 *   1. no consistent legacy row lacks its mirror row (origin and workspace_id included);
 *   2. no duplicate (from, type, to) pair;
 *   3. every mirror row's workspace_id equals both endpoints', and no endpoint is missing, except where the legacy counterpart is one of
 *      the reported quarantined rows (a legacy row that is itself dangling or cross-workspace is reported, never repaired here).
 */
export async function assertEntityLinksArtifactBackfill(client: PoolClient, schema: string) {
  const unmatched = await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorOf(schema)} WHERE ${unmatchedWhere}`)
  if (unmatched !== 0) throw refuse(`coverage postcondition failed: ${unmatched} consistent artifact_links rows have no matching entity_links row`)

  const duplicates = await count(client, `SELECT count(*)::text AS n FROM (
         SELECT from_id FROM "${schema}"."entity_links" WHERE link_type IN ('${ARTIFACT_SOLUTION_KEY}', '${ARTIFACT_DECISION_KEY}')
         GROUP BY from_id, link_type, to_id HAVING count(*) > 1
       ) AS dup`)
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)

  const unexplained = (predicate: string) => `SELECT count(*)::text AS n FROM ${mirrorRows(schema)}
         WHERE ${ourMirrorRows} AND (${predicate}) AND (l.id IS NULL OR (${classOf}) = 'ok')`
  const dangling = await count(client, unexplained("a.id IS NULL OR (sol.id IS NULL AND r.id IS NULL)"))
  if (dangling !== 0) throw refuse(`integrity postcondition failed: ${dangling} artifact mirror rows have a missing endpoint that is not a reported quarantined row`)
  const mismatch = await count(client, unexplained(`e.workspace_id IS DISTINCT FROM a.workspace_id OR e.workspace_id IS DISTINCT FROM COALESCE(sol.workspace_id, r.workspace_id)`))
  if (mismatch !== 0) throw refuse(`tenant postcondition failed: ${mismatch} artifact mirror rows have a workspace_id that differs from an endpoint's`)
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type EntityLinksArtifactStatus = {
  legacyLinks: number
  legacyLinksByType: Record<string, number>
  mirroredSolutionLinks: number
  mirroredDecisionLinks: number
  /** Consistent legacy rows the backfill would still insert or repair. */
  unmatched: number
  /** Mirror rows with no legacy counterpart; a re-POST prunes them until the receipt exists (an applied migration is never re-run). */
  staleMirrorRows: number
  quarantined: ArtifactLinksQuarantine
  /** Mirror rows kept (not deleted) because their legacy row is quarantined. */
  mirrorRowsKeptForQuarantine: MirrorRowsKept
}

/** Counts and capped ids only (no titles or content). Throws if a table is missing; the caller turns that into an error field. */
export async function getEntityLinksArtifactStatus(client: PoolClient, schema: string): Promise<EntityLinksArtifactStatus> {
  const byType = await client.query<{ linked_type: string; n: string }>(`SELECT linked_type, count(*)::text AS n FROM "${schema}"."artifact_links" GROUP BY linked_type`)
  return {
    legacyLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."artifact_links"`),
    legacyLinksByType: Object.fromEntries(byType.rows.map((row) => [row.linked_type, num(row.n)])),
    mirroredSolutionLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${ARTIFACT_SOLUTION_KEY}'`),
    mirroredDecisionLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${ARTIFACT_DECISION_KEY}'`),
    unmatched: await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorOf(schema)} WHERE ${unmatchedWhere}`),
    staleMirrorRows: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS e
         LEFT JOIN "${schema}"."artifact_links" AS counterpart ON counterpart.artifact_id = e.from_id AND counterpart.linked_id = e.to_id AND counterpart.linked_type = e.to_type
         WHERE ${ourMirrorRows} AND counterpart.id IS NULL`),
    quarantined: await findQuarantinedArtifactLinks(client, schema),
    mirrorRowsKeptForQuarantine: await findMirrorRowsKeptForQuarantine(client, schema),
  }
}
