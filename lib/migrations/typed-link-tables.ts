import type { PoolClient } from "pg"

export const TYPED_LINK_TABLES_MIGRATION = "071_typed_link_tables"
/** No DDL: re-runs this file's idempotent backfill and postconditions after the code that dual-writes the links is live. */
export const TYPED_LINK_RESIDUAL_MIGRATION = "072_typed_links_residual_backfill"
const WORKSPACE_ID_MIGRATION = "068_workspace_id_on_solution_objective"

/*
 * Private copy of the optimistic-concurrency retry used by migration 068's hook
 * (lib/migrations/workspace-id-on-solution-objective.ts), kept byte-for-byte in
 * behaviour: SQLSTATE 40001 / OC000 / OC001, bounded, exponential with jitter.
 * It is deliberately NOT imported from the 068 hook. Each reviewed hook file is
 * pinned by digest in the managed manifest, and other PRs edit the 068 hook, so
 * importing it would turn an unrelated edit there into a red digest check here
 * (and vice versa) for whichever PR lands second.
 */
/** Aurora DSQL uses optimistic concurrency: a conflicting commit fails with SQLSTATE 40001 (OC000/OC001) and must be retried. */
export const OCC_MAX_ATTEMPTS = 6
const OCC_BASE_DELAY_MS = 50

export function isOccConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === "40001" || /\bOC00[01]\b|change conflicts with another transaction/i.test(e?.message ?? "")
}

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
 * DSQL caps a write transaction at 3,000 modified rows, and index entries count
 * toward it: each inserted link is 1 table row plus 3 secondary index entries
 * (pair, reverse, workspace) = 4. 500 links is ~2,000, leaving a third of the
 * budget as headroom. Reusable as-is by a later residual migration.
 */
export const TYPED_LINK_BACKFILL_BATCH_SIZE = 500

/** Logged orphan ids are capped so a pathological dataset cannot bloat the response; the count is always exact. */
const LOGGED_ORPHAN_ID_CAP = 200

type LinkTable = {
  table: "opportunity_objective_links" | "solution_key_result_links"
  columns: readonly string[]
  /** [index name, must be unique] */
  indexes: readonly (readonly [string, boolean])[]
}

const LINK_TABLES: readonly LinkTable[] = [
  {
    table: "opportunity_objective_links",
    columns: ["id", "workspace_id", "opportunity_id", "objective_id", "origin", "source", "created_by_id", "created_at"],
    indexes: [
      ["idx_opportunity_objective_links_pair", true],
      ["idx_opportunity_objective_links_objective", false],
      ["idx_opportunity_objective_links_workspace", false],
    ],
  },
  {
    table: "solution_key_result_links",
    columns: ["id", "workspace_id", "solution_id", "key_result_id", "source", "created_by_id", "created_at"],
    indexes: [
      ["idx_solution_key_result_links_pair", true],
      ["idx_solution_key_result_links_key_result", false],
      ["idx_solution_key_result_links_workspace", false],
    ],
  },
]

const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) =>
  num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)

/** The legacy pointer chain: opportunity -> key result -> objective. Shared by every legacy query below. */
const legacyFrom = (schema: string) => `FROM "${schema}"."opportunities" AS o
         JOIN "${schema}"."key_results" AS kr ON kr.id = o.linked_key_result_id
         JOIN "${schema}"."objectives" AS obj ON obj.id = kr.objective_id`

/** Same-workspace legacy rows that do not have their link yet. */
const legacyUnlinkedFromWhere = (schema: string) => `${legacyFrom(schema)}
         LEFT JOIN "${schema}"."opportunity_objective_links" AS l ON l.opportunity_id = o.id AND l.objective_id = obj.id
         WHERE o.linked_key_result_id IS NOT NULL AND obj.workspace_id = o.workspace_id AND l.id IS NULL`

const crossWorkspaceFromWhere = (schema: string) => `${legacyFrom(schema)}
         WHERE o.linked_key_result_id IS NOT NULL AND obj.workspace_id <> o.workspace_id`

/**
 * The objective exists but its workspace_id is NULL, so `=` and `<>` are both NULL
 * and the pointer would otherwise be in no class at all. Old code can keep creating
 * NULL-workspace objectives until the workspace_id writers deploy and 069 runs, so
 * this is re-checked at the postcondition, not only by the precondition.
 */
const objectiveWorkspaceNullFromWhere = (schema: string) => `${legacyFrom(schema)}
         WHERE o.linked_key_result_id IS NOT NULL AND obj.workspace_id IS NULL`

const danglingFromWhere = (schema: string) => `FROM "${schema}"."opportunities" AS o
         LEFT JOIN "${schema}"."key_results" AS kr ON kr.id = o.linked_key_result_id
         LEFT JOIN "${schema}"."objectives" AS obj ON obj.id = kr.objective_id
         WHERE o.linked_key_result_id IS NOT NULL AND (kr.id IS NULL OR obj.id IS NULL)`

/**
 * Fail closed, before any DDL or receipt: the links copy objectives.workspace_id
 * comparisons from migration 068, so 068 must be applied and complete. The residual
 * pass (072) additionally needs 071, which creates the tables it re-reads.
 */
export async function assertTypedLinkPreconditions(client: PoolClient, schema: string, migrationName: string = TYPED_LINK_TABLES_MIGRATION) {
  const receipt = await count(
    client,
    `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
    [WORKSPACE_ID_MIGRATION],
  )
  if (receipt === 0) {
    throw new Error(`${migrationName}: precondition failed: ${WORKSPACE_ID_MIGRATION} is not applied. Apply it first; nothing was changed.`)
  }
  if (migrationName === TYPED_LINK_RESIDUAL_MIGRATION) {
    const created = await count(
      client,
      `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      [TYPED_LINK_TABLES_MIGRATION],
    )
    if (created === 0) {
      throw new Error(`${migrationName}: precondition failed: ${TYPED_LINK_TABLES_MIGRATION} is not applied. Apply it first; nothing was changed.`)
    }
  }
  const column = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objectives' AND column_name = 'workspace_id'",
    [schema],
  )
  if (column.rows.length !== 1) {
    throw new Error(`${migrationName}: precondition failed: objectives.workspace_id does not exist. Nothing was changed.`)
  }
  const nulls = await count(client, `SELECT count(*)::text AS n FROM "${schema}"."objectives" WHERE workspace_id IS NULL`)
  if (nulls !== 0) {
    throw new Error(`${migrationName}: precondition failed: ${nulls} objectives rows have a NULL workspace_id. Apply migration 069 (PR #331) until legacyObjectiveWorkspaceNull is 0, then re-POST 071; nothing was changed.`)
  }
}

export type QuarantinedLegacyLinks = { crossWorkspace: string[]; dangling: string[] }

/**
 * Legacy pointers that must NOT become links: the key result's objective lives in
 * a different workspace than the opportunity, or the key result / objective row is
 * gone. They are left exactly as they are on the opportunity and reported.
 */
export async function findQuarantinedLegacyLinks(client: PoolClient, schema: string): Promise<QuarantinedLegacyLinks> {
  const ids = async (sql: string) => (await client.query<{ opportunity_id: string }>(sql)).rows.map((r) => r.opportunity_id)
  return {
    crossWorkspace: await ids(`SELECT o.id AS opportunity_id ${crossWorkspaceFromWhere(schema)} ORDER BY o.id`),
    dangling: await ids(`SELECT o.id AS opportunity_id ${danglingFromWhere(schema)} ORDER BY o.id`),
  }
}

function logQuarantine(log: string[], label: string, ids: string[]) {
  if (ids.length === 0) return
  const shown = ids.slice(0, LOGGED_ORPHAN_ID_CAP).join(", ")
  const more = ids.length > LOGGED_ORPHAN_ID_CAP ? ` … and ${ids.length - LOGGED_ORPHAN_ID_CAP} more` : ""
  log.push(`  ! quarantined ${ids.length} ${label} legacy linked_key_result_id pointer(s), left unlinked and untouched (opportunity ids): ${shown}${more}`)
}

/**
 * Copies same-workspace legacy Opportunity -> KR -> Objective pointers into
 * opportunity_objective_links as origin LEGACY, source MIGRATION, in bounded
 * batches. Idempotent and resumable: the candidate query anti-joins the links
 * already present, so a rerun after a crash continues and a finished run inserts
 * nothing. Loops until a batch is empty.
 *
 * Deliberately no ON CONFLICT: its behaviour against an ASYNC unique index on DSQL
 * is unverified (migration 036 avoids it for the same reason). The anti-join makes
 * a duplicate impossible here, and the unique index still rejects one if a racing
 * writer ever appears, which fails the run closed instead of silently skipping.
 *
 * Plain SELECT-then-INSERT (no CTE with LIMIT), as in migration 068's hook.
 */
export async function backfillOpportunityObjectiveLinks(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: (ms: number) => Promise<void>,
  migrationName: string = TYPED_LINK_TABLES_MIGRATION,
): Promise<{ pruned: number; inserted: number; quarantined: QuarantinedLegacyLinks }> {
  await assertTypedLinkPreconditions(client, schema, migrationName)

  // Old code keeps running between a failed attempt and its resume (and between
  // 071 and a later 072). It can delete an opportunity or objective, clear or
  // change linked_key_result_id, or drift a workspace after links were inserted.
  // Insert-only would then fail the postconditions forever with no data-repair
  // path, so stale LEGACY links are removed first. DIRECT links are never touched.
  const pruned = await pruneStaleLegacyLinks(client, schema, log, sleep)

  let inserted = 0
  while (true) {
    const batch = await client.query<{ opportunity_id: string; workspace_id: string; objective_id: string }>(
      `SELECT o.id AS opportunity_id, o.workspace_id AS workspace_id, obj.id AS objective_id
         ${legacyUnlinkedFromWhere(schema)}
         LIMIT $1`,
      [TYPED_LINK_BACKFILL_BATCH_SIZE],
    )
    if (batch.rows.length === 0) break
    const params: string[] = []
    const values = batch.rows.map((row, i) => {
      params.push(row.workspace_id, row.opportunity_id, row.objective_id)
      const n = i * 3
      return `($${n + 1}::uuid, $${n + 2}::uuid, $${n + 3}::uuid, 'LEGACY', 'MIGRATION')`
    })
    const result = await withOccRetry(
      () => client.query(
        `INSERT INTO "${schema}"."opportunity_objective_links" (workspace_id, opportunity_id, objective_id, origin, source) VALUES ${values.join(", ")}`,
        params,
      ),
      sleep,
    )
    inserted += result.rowCount ?? 0
  }
  log.push(`  ✓ inserted ${inserted} LEGACY opportunity_objective_links rows (pruned ${pruned} stale first)`)

  const quarantined = await findQuarantinedLegacyLinks(client, schema)
  logQuarantine(log, "cross-workspace", quarantined.crossWorkspace)
  logQuarantine(log, "dangling", quarantined.dangling)
  log.push(`  ✓ quarantined ${quarantined.crossWorkspace.length} cross-workspace and ${quarantined.dangling.length} dangling legacy pointers (not blocking)`)

  // User-made links are never deleted here. One whose endpoint is gone or whose workspace_id disagrees with an endpoint
  // is REPORTED, not fixed and not failed on: the receipt must not dead-end on a row only a human can resolve.
  const direct = await getDirectLinkReport(client, schema)
  log.push(`  ✓ reported ${direct.directDangling} DIRECT/solution links with a missing endpoint and ${direct.directWorkspaceMismatch} with a workspace mismatch (kept, not blocking; see linkIntegrity.directDangling / directWorkspaceMismatch)`)
  return { pruned, inserted, quarantined }
}

/**
 * A LEGACY link is current only while its legacy pointer still maps to exactly
 * that (opportunity, objective) pair in a consistent workspace. It is stale when
 * an endpoint row is gone, the pointer was cleared or now leads to a different
 * objective, or the link's workspace_id disagrees with either endpoint's
 * (an objective with a NULL workspace counts as disagreeing).
 *
 * The join to key_results carries `kr.objective_id = l.objective_id`, so a changed
 * pointer simply finds no key result and the link is stale. origin = 'LEGACY' is in
 * both the SELECT and the DELETE, so a DIRECT row can never be selected or removed.
 */
const staleLegacyLinkSelect = (schema: string) => `SELECT l.id AS id
         FROM "${schema}"."opportunity_objective_links" AS l
         LEFT JOIN "${schema}"."opportunities" AS o ON o.id = l.opportunity_id
         LEFT JOIN "${schema}"."key_results" AS kr ON kr.id = o.linked_key_result_id AND kr.objective_id = l.objective_id
         LEFT JOIN "${schema}"."objectives" AS obj ON obj.id = kr.objective_id
         WHERE l.origin = 'LEGACY'
           AND (o.id IS NULL OR kr.id IS NULL OR obj.id IS NULL
                OR l.workspace_id IS DISTINCT FROM o.workspace_id OR l.workspace_id IS DISTINCT FROM obj.workspace_id)`

/**
 * Deletes stale LEGACY links in batches. Every deleted link is 4 modified rows
 * (table row + 3 index entries), so the same 500 cap as the insert applies.
 * Idempotent: a clean table selects nothing. A link whose pointer is still valid
 * but whose workspace drifted is deleted here and re-inserted correctly by the
 * backfill that follows. Part of the shared function a later 072 re-runs.
 */
export async function pruneStaleLegacyLinks(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: (ms: number) => Promise<void>,
): Promise<number> {
  let pruned = 0
  while (true) {
    const stale = await client.query<{ id: string }>(`${staleLegacyLinkSelect(schema)}
         LIMIT $1`, [TYPED_LINK_BACKFILL_BATCH_SIZE])
    if (stale.rows.length === 0) break
    const result = await withOccRetry(
      () => client.query(
        `DELETE FROM "${schema}"."opportunity_objective_links" WHERE id = ANY($1::uuid[]) AND origin = 'LEGACY'`,
        [stale.rows.map((row) => row.id)],
      ),
      sleep,
    )
    const deleted = result.rowCount ?? 0
    // Selected rows that the guarded DELETE cannot remove would loop forever.
    if (deleted === 0) throw new Error(`${TYPED_LINK_TABLES_MIGRATION}: prune made no progress on ${stale.rows.length} stale LEGACY links`)
    pruned += deleted
  }
  log.push(`  ✓ pruned ${pruned} stale LEGACY opportunity_objective_links rows (endpoint gone, pointer cleared or changed, or workspace drift)`)
  return pruned
}

export type LegacyPointerPartition = {
  total: number
  sameWorkspace: number
  crossWorkspace: number
  dangling: number
  objectiveWorkspaceNull: number
}

/** Every non-NULL legacy pointer must fall in exactly one class; opportunities.workspace_id is NOT NULL so the four are exhaustive. */
export async function getLegacyPointerPartition(client: PoolClient, schema: string): Promise<LegacyPointerPartition> {
  return {
    total: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."opportunities" AS o WHERE o.linked_key_result_id IS NOT NULL`),
    sameWorkspace: await count(client, `SELECT count(*)::text AS n ${legacyFrom(schema)} WHERE o.linked_key_result_id IS NOT NULL AND obj.workspace_id = o.workspace_id`),
    crossWorkspace: await count(client, `SELECT count(*)::text AS n ${crossWorkspaceFromWhere(schema)}`),
    dangling: await count(client, `SELECT count(*)::text AS n ${danglingFromWhere(schema)}`),
    objectiveWorkspaceNull: await count(client, `SELECT count(*)::text AS n ${objectiveWorkspaceNullFromWhere(schema)}`),
  }
}

/** Per-table endpoint checks. The alias names are part of the query shape the unit tests pin. */
type EndpointSql = {
  label: string
  table: LinkTable["table"]
  /**
   * LEGACY links whose workspace_id differs from either endpoint's (NULL endpoint workspace counts as a difference), and LEGACY
   * links with a missing endpoint. Fail-closed postconditions: pruneStaleLegacyLinks removes exactly these before the backfill,
   * so any left afterwards means old code raced the run, and retrying is safe. Absent for a table that has no LEGACY rows.
   */
  legacyMismatch?: (schema: string) => string
  legacyDangling?: (schema: string) => string
  /**
   * User-made links (DIRECT, and every solution_key_result_links row) with a differing workspace_id or a missing endpoint. REPORTED
   * (linkIntegrity.directWorkspaceMismatch / directDangling), never deleted and never a reason to refuse the receipt: a human has
   * to decide what a dangling user-made link means.
   */
  directMismatch: (schema: string) => string
  directDangling: (schema: string) => string
  duplicates: (schema: string) => string
}

const oppObjMismatch = (s: string, origin: "LEGACY" | "DIRECT") => `SELECT count(*)::text AS n FROM "${s}"."opportunity_objective_links" AS l
       JOIN "${s}"."opportunities" AS o ON o.id = l.opportunity_id
       JOIN "${s}"."objectives" AS obj ON obj.id = l.objective_id
       WHERE l.origin = '${origin}' AND (l.workspace_id IS DISTINCT FROM o.workspace_id OR l.workspace_id IS DISTINCT FROM obj.workspace_id)`
const oppObjDangling = (s: string, origin: "LEGACY" | "DIRECT") => `SELECT count(*)::text AS n FROM "${s}"."opportunity_objective_links" AS l
       LEFT JOIN "${s}"."opportunities" AS o ON o.id = l.opportunity_id
       LEFT JOIN "${s}"."objectives" AS obj ON obj.id = l.objective_id
       WHERE l.origin = '${origin}' AND (o.id IS NULL OR obj.id IS NULL)`

const ENDPOINT_SQL: readonly EndpointSql[] = [
  {
    label: "opportunity_objective_links",
    table: "opportunity_objective_links",
    legacyMismatch: (s) => oppObjMismatch(s, "LEGACY"),
    legacyDangling: (s) => oppObjDangling(s, "LEGACY"),
    directMismatch: (s) => oppObjMismatch(s, "DIRECT"),
    directDangling: (s) => oppObjDangling(s, "DIRECT"),
    // Belt and braces next to the unique pair index: whether DSQL enforces an ASYNC unique index
    // completely while it builds is unverified, so uniqueness is also checked directly.
    duplicates: (s) => `SELECT count(*)::text AS n FROM (SELECT 1 FROM "${s}"."opportunity_objective_links" GROUP BY opportunity_id, objective_id HAVING count(*) > 1) AS d`,
  },
  {
    label: "solution_key_result_links",
    table: "solution_key_result_links",
    // A key result has no workspace column of its own: its workspace is its objective's. Every row here is user-made.
    directMismatch: (s) => `SELECT count(*)::text AS n FROM "${s}"."solution_key_result_links" AS l
       JOIN "${s}"."solutions" AS sol ON sol.id = l.solution_id
       JOIN "${s}"."key_results" AS kr ON kr.id = l.key_result_id
       JOIN "${s}"."objectives" AS obj ON obj.id = kr.objective_id
       WHERE l.workspace_id IS DISTINCT FROM sol.workspace_id OR l.workspace_id IS DISTINCT FROM obj.workspace_id`,
    directDangling: (s) => `SELECT count(*)::text AS n FROM "${s}"."solution_key_result_links" AS l
       LEFT JOIN "${s}"."solutions" AS sol ON sol.id = l.solution_id
       LEFT JOIN "${s}"."key_results" AS kr ON kr.id = l.key_result_id
       LEFT JOIN "${s}"."objectives" AS obj ON obj.id = kr.objective_id
       WHERE sol.id IS NULL OR kr.id IS NULL OR obj.id IS NULL`,
    duplicates: (s) => `SELECT count(*)::text AS n FROM (SELECT 1 FROM "${s}"."solution_key_result_links" GROUP BY solution_id, key_result_id HAVING count(*) > 1) AS d`,
  },
]

export type DirectLinkReport = { directDangling: number; directWorkspaceMismatch: number }

/** Counts of user-made links (DIRECT and every solution-key result link) that need a human: reported, never repaired or failed on. */
export async function getDirectLinkReport(client: PoolClient, schema: string): Promise<DirectLinkReport> {
  let directDangling = 0
  let directWorkspaceMismatch = 0
  for (const endpoint of ENDPOINT_SQL) {
    directDangling += await count(client, endpoint.directDangling(schema))
    directWorkspaceMismatch += await count(client, endpoint.directMismatch(schema))
  }
  return { directDangling, directWorkspaceMismatch }
}

/**
 * Postconditions, all of which must hold before the receipt is recorded:
 *   1. both tables exist with the expected columns and a NOT NULL workspace_id;
 *   2. every index exists and is valid, and both pair indexes are unique;
 *   3. opportunity_objective_links.origin is DIRECT or LEGACY everywhere;
 *   4. no same-workspace legacy pointer lacks its link (quarantined orphans excluded);
 *   5. every LEGACY link's workspace_id equals both endpoints' workspace_id;
 *   6. no LEGACY link has a missing endpoint;
 *   7. no duplicate (left, right) pairs.
 * DIRECT links (and every solution-key result link) with a missing endpoint or a workspace mismatch are NOT postconditions:
 * they are reported (getDirectLinkReport) so the migration cannot dead-end on a user-made row.
 */
export async function assertTypedLinkTables(client: PoolClient, schema: string, migrationName: string = TYPED_LINK_TABLES_MIGRATION) {
  for (const target of LINK_TABLES) {
    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
      [schema, target.table],
    )
    const present = new Set(columns.rows.map((r) => r.column_name))
    const missing = target.columns.filter((c) => !present.has(c))
    if (missing.length > 0) {
      throw new Error(`${migrationName}: table postcondition failed: ${target.table} is missing ${missing.join(", ")}`)
    }
    if (columns.rows.find((r) => r.column_name === "workspace_id")?.is_nullable !== "NO") {
      throw new Error(`${migrationName}: table postcondition failed: ${target.table}.workspace_id must be NOT NULL`)
    }
    for (const [indexName, mustBeUnique] of target.indexes) {
      const index = await client.query<{ indisvalid: boolean; indisunique: boolean }>(
        `SELECT i.indisvalid, i.indisunique
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, indexName],
      )
      if (index.rows.length !== 1 || index.rows[0].indisvalid !== true) {
        throw new Error(`${migrationName}: index postcondition failed: ${indexName} missing or invalid`)
      }
      if (mustBeUnique && index.rows[0].indisunique !== true) {
        throw new Error(`${migrationName}: index postcondition failed: ${indexName} must be unique`)
      }
    }
  }

  const badOrigin = await count(client, `SELECT count(*)::text AS n FROM "${schema}"."opportunity_objective_links" WHERE origin NOT IN ('DIRECT', 'LEGACY')`)
  if (badOrigin !== 0) {
    throw new Error(`${migrationName}: origin postcondition failed: ${badOrigin} opportunity_objective_links rows have an origin other than DIRECT or LEGACY`)
  }

  const unlinked = await count(client, `SELECT count(*)::text AS n ${legacyUnlinkedFromWhere(schema)}`)
  if (unlinked !== 0) {
    throw new Error(`${migrationName}: backfill postcondition failed: ${unlinked} legacy opportunity rows lack a link`)
  }

  // Fail closed on a pointer the classification cannot place. A NULL objective
  // workspace makes both `=` and `<>` NULL, so without this the receipt could be
  // written with an unlinked pointer that is neither linked nor quarantined.
  const partition = await getLegacyPointerPartition(client, schema)
  if (partition.objectiveWorkspaceNull !== 0) {
    throw new Error(`${migrationName}: partition postcondition failed: ${partition.objectiveWorkspaceNull} legacy pointers reference an objective with a NULL workspace_id (apply migration 069 (PR #331) until legacyObjectiveWorkspaceNull is 0, then re-POST 071)`)
  }
  const classified = partition.sameWorkspace + partition.crossWorkspace + partition.dangling + partition.objectiveWorkspaceNull
  if (classified !== partition.total) {
    throw new Error(`${migrationName}: partition postcondition failed: ${partition.total} legacy pointers but only ${classified} fall in a known class`)
  }

  for (const endpoint of ENDPOINT_SQL) {
    // Only LEGACY rows fail closed here: they are derived data and the prune above removes exactly these. A DIRECT (or solution)
    // link with a missing endpoint or a workspace mismatch is the user's own data: it is reported by getDirectLinkReport and
    // linkIntegrity, never deleted, and does not stop the receipt.
    if (endpoint.legacyMismatch) {
      const mismatch = await count(client, endpoint.legacyMismatch(schema))
      if (mismatch !== 0) {
        throw new Error(`${migrationName}: agreement postcondition failed: ${mismatch} LEGACY ${endpoint.label} rows have a workspace_id that differs from an endpoint's`)
      }
    }
    if (endpoint.legacyDangling) {
      const dangling = await count(client, endpoint.legacyDangling(schema))
      if (dangling !== 0) {
        throw new Error(`${migrationName}: endpoint postcondition failed: ${dangling} LEGACY ${endpoint.label} rows point at a missing endpoint`)
      }
    }
    const duplicates = await count(client, endpoint.duplicates(schema))
    if (duplicates !== 0) {
      throw new Error(`${migrationName}: uniqueness postcondition failed: ${duplicates} duplicate ${endpoint.label} pairs`)
    }
  }
}

export type TypedLinkPreflight = {
  tablesPresent: boolean
  /** Legacy pointers whose key result or objective row is missing. Readable before the migration runs. */
  legacyDangling: number
  /** Legacy pointers whose objective is in another workspace. Null until objectives.workspace_id exists (migration 068). */
  legacyCrossWorkspace: number | null
  /** Legacy pointers whose objective has a NULL workspace_id. 071 refuses its receipt while this is non-zero. Null until the column exists. */
  legacyObjectiveWorkspaceNull: number | null
}

export type TypedLinkIntegrity = {
  legacyWithoutLink: number
  /** LEGACY opportunity-objective links whose workspace_id differs from an endpoint's. A postcondition: zero after a successful run. */
  workspaceMismatch: number
  /** LEGACY opportunity-objective links with a missing endpoint. A postcondition: zero after a successful run. */
  danglingEndpoint: number
  /** User-made links (DIRECT, and every solution-key result link) with a missing endpoint. Reported only: kept, never fails a receipt. */
  directDangling: number
  /** User-made links whose workspace_id differs from an endpoint's. Reported only. */
  directWorkspaceMismatch: number
  duplicates: number
  legacyCrossWorkspace: number
  legacyDangling: number
  legacyObjectiveWorkspaceNull: number
}

/**
 * Read-only status for GET /api/admin/migrate. Counts only, no row data.
 * `linkIntegrity` is null while the tables do not exist; `preflight` is always
 * present so the quarantine size is visible before 071 is posted.
 */
export async function getTypedLinkStatus(
  client: PoolClient,
  schema: string,
): Promise<{ preflight: TypedLinkPreflight; linkIntegrity: TypedLinkIntegrity | null }> {
  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, LINK_TABLES.map((t) => t.table)],
  )
  const tablesPresent = LINK_TABLES.every((t) => tables.rows.some((r) => r.table_name === t.table))
  const workspaceColumn = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objectives' AND column_name = 'workspace_id'",
    [schema],
  )
  const legacyDangling = await count(client, `SELECT count(*)::text AS n ${danglingFromWhere(schema)}`)
  const legacyCrossWorkspace = workspaceColumn.rows.length === 1
    ? await count(client, `SELECT count(*)::text AS n ${crossWorkspaceFromWhere(schema)}`)
    : null
  const legacyObjectiveWorkspaceNull = workspaceColumn.rows.length === 1
    ? await count(client, `SELECT count(*)::text AS n ${objectiveWorkspaceNullFromWhere(schema)}`)
    : null
  const preflight: TypedLinkPreflight = { tablesPresent, legacyDangling, legacyCrossWorkspace, legacyObjectiveWorkspaceNull }
  if (!tablesPresent || legacyCrossWorkspace === null || legacyObjectiveWorkspaceNull === null) return { preflight, linkIntegrity: null }

  let workspaceMismatch = 0
  let danglingEndpoint = 0
  let duplicates = 0
  for (const endpoint of ENDPOINT_SQL) {
    if (endpoint.legacyMismatch) workspaceMismatch += await count(client, endpoint.legacyMismatch(schema))
    if (endpoint.legacyDangling) danglingEndpoint += await count(client, endpoint.legacyDangling(schema))
    duplicates += await count(client, endpoint.duplicates(schema))
  }
  const direct = await getDirectLinkReport(client, schema)
  return {
    preflight,
    linkIntegrity: {
      legacyWithoutLink: await count(client, `SELECT count(*)::text AS n ${legacyUnlinkedFromWhere(schema)}`),
      workspaceMismatch,
      danglingEndpoint,
      directDangling: direct.directDangling,
      directWorkspaceMismatch: direct.directWorkspaceMismatch,
      duplicates,
      legacyCrossWorkspace,
      legacyDangling,
      legacyObjectiveWorkspaceNull,
    },
  }
}
