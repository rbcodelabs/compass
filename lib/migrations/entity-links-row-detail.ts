/**
 * entityLinksRowDetail in GET /api/admin/migrate: READ-ONLY metadata for the specific entity_links rows an owner needs to explain.
 *
 * Two sources, merged and capped at ROW_CAP rows (`truncated` says when more existed):
 *   1. every id that entityLinksReadParity reports in ids.onlyEntityLinks / onlyLegacy / originDrift (no hardcoded ids). Legacy ids are
 *      looked up in entity_links as well: migration 115 copied the task_links ids, so a legacy id usually names its twin. An id with no
 *      entity_links row is listed under `idsWithoutEntityLinksRow`.
 *   2. a scan for HIDDEN task-owned rows: entity_links rows of every link type the registry says a TASK owns (TASK_REFERENCES,
 *      TASK_CREATED_FROM, ...) for which the task readers (lib/links/readers.ts) would drop the row, because an endpoint is missing or lives in
 *      another workspace than the row.
 *
 * Only metadata is returned: ids, types, workspace, timestamps, actor, source, origin and booleans. Never a title, body or other content.
 * Nothing here writes (SELECT only). It touches entity_links and the entity tables needed for existence checks; it never reads a legacy
 * table, so it keeps working after task_links and the other legacy link tables are dropped. No SET LOCAL, no advisory lock, no transaction:
 * id lookups are chunked, and the one scan is bounded by LIMIT (it reads entity_links filtered by link type once, like the parity status).
 *
 * THE RESOLUTION RULE. The readers keep a link only if BOTH endpoints are returned by resolveEndpoints (lib/links/endpoints.ts) for the
 * ROW's workspace. The SQL below is that rule, branch for branch (the table and workspace column of each type, a Key Result through its
 * Objective, a tool approval is not a linkable review request). The only task-owned types come from the registry and the tool-approval gate
 * from lib/tool-approval/gate.ts, so neither is restated here; __tests__/links/entity-links-row-detail.test.ts keeps the type coverage
 * and the `find()` branches of endpoints.ts in step.
 */
import type { PoolClient } from "pg"
import { readParitySetsSql, type EntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
import { LINK_TYPES } from "@/lib/links/registry"
import { TOOL_APPROVAL_GATE } from "@/lib/tool-approval/gate"

export const ROW_DETAIL_CAP = 50
const ID_CHUNK = 200

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Link types whose `from` entity is a Task: the task-owned family the task screen reads. Derived from the registry, never listed by hand. */
export const TASK_OWNED_LINK_TYPES: readonly string[] = Object.values(LINK_TYPES).filter((def) => def.from === "TASK").map((def) => def.key).sort()

/**
 * Per endpoint type: a FROM-able relation exposing `id`, `workspace_id` and `ok` (false when the reader's resolveEndpoints would refuse the
 * row even inside its workspace). One explicit branch per type, as in endpoints.ts; no computed table names.
 */
const sources = (s: string): Record<string, string> => {
  const plain = (table: string) => `SELECT id, workspace_id, true AS ok FROM "${s}"."${table}"`
  return {
    OBJECTIVE: plain("objectives"),
    KEY_RESULT: `SELECT k.id, o.workspace_id, true AS ok FROM "${s}"."key_results" AS k JOIN "${s}"."objectives" AS o ON o.id = k.objective_id`,
    OPPORTUNITY: plain("opportunities"),
    SOLUTION: plain("solutions"),
    EXPERIMENT: plain("experiments"),
    ROADMAP_ITEM: plain("roadmap_items"),
    FEEDBACK_ITEM: plain("feedback"),
    TASK: plain("tasks"),
    DOC: plain("docs"),
    ARTIFACT: plain("artifacts"),
    REVIEW_REQUEST: `SELECT id, workspace_id, gate_type IS DISTINCT FROM ${quote(TOOL_APPROVAL_GATE)} AS ok FROM "${s}"."review_requests"`,
    COMMENT: plain("comments"),
    AGENT_CONVERSATION: plain("agent_conversations"),
  }
}

/** The endpoint types this status can resolve; anything else (a type outside the vocabulary) resolves to nothing, like an unknown row. */
export const ROW_DETAIL_ENDPOINT_TYPES: readonly string[] = Object.keys(sources("s"))

/** `EXISTS` over every known type: the row (type column `typeExpr`, id `idExpr`) exists, optionally in `wsExpr`, and is `ok` when `needOk`. */
function endpoint(s: string, typeExpr: string, idExpr: string, opts: { wsExpr?: string; needOk?: boolean }): string {
  const branches = Object.entries(sources(s)).map(([type, from]) =>
    `(${typeExpr} = ${quote(type)} AND EXISTS (SELECT 1 FROM (${from}) AS x WHERE x.id = ${idExpr}${opts.wsExpr ? ` AND x.workspace_id = ${opts.wsExpr}` : ""}${opts.needOk ? " AND x.ok" : ""}))`)
  return `(${branches.join(" OR ")})`
}

/** The workspace of an endpoint row (NULL when it is missing or has none), as a scalar subquery per type. */
function endpointWorkspace(s: string, typeExpr: string, idExpr: string): string {
  const branches = Object.entries(sources(s)).map(([type, from]) => `WHEN ${typeExpr} = ${quote(type)} THEN (SELECT x.workspace_id FROM (${from}) AS x WHERE x.id = ${idExpr})`)
  return `(CASE ${branches.join(" ")} END)`
}

/** Pure SQL builders, exported for the unit test only. */
export const rowDetailSql = {
  /** Hidden task-owned rows: the registry's task-owned types, with an endpoint the readers would drop. */
  hiddenIds: (s: string): string => `SELECT e.id::text AS id FROM "${s}"."entity_links" AS e
    WHERE e.link_type IN (${TASK_OWNED_LINK_TYPES.map(quote).join(", ")})
      AND NOT (${endpoint(s, "e.from_type", "e.from_id", { wsExpr: "e.workspace_id", needOk: true })} AND ${endpoint(s, "e.to_type", "e.to_id", { wsExpr: "e.workspace_id", needOk: true })})
    ORDER BY e.created_at, e.id LIMIT ${ROW_DETAIL_CAP + 1}`,
  /** Metadata of the rows named by `ids` (a parameter list `$1..$n`). Nothing but ids, types, timestamps, actor and booleans. */
  detail: (s: string, placeholders: string): string => `SELECT e.id::text AS id, e.link_type, e.from_type, e.from_id::text AS from_id, e.to_type, e.to_id::text AS to_id,
      e.workspace_id::text AS workspace_id, e.created_at, e.created_by_id::text AS created_by_id, e.source, e.origin,
      ${endpoint(s, "e.from_type", "e.from_id", {})} AS from_exists,
      ${endpoint(s, "e.to_type", "e.to_id", {})} AS to_exists,
      ${endpointWorkspace(s, "e.from_type", "e.from_id")} = e.workspace_id AND ${endpointWorkspace(s, "e.to_type", "e.to_id")} = e.workspace_id AS same_workspace,
      ${endpoint(s, "e.from_type", "e.from_id", { wsExpr: "e.workspace_id", needOk: true })} AS from_resolves,
      ${endpoint(s, "e.to_type", "e.to_id", { wsExpr: "e.workspace_id", needOk: true })} AS to_resolves
    FROM "${s}"."entity_links" AS e WHERE e.id IN (${placeholders})`,
}

export type ParityOrigin = { family: string; set: "onlyLegacy" | "onlyEntityLinks" | "originDrift" }

export type EntityLinksRowDetail = {
  id: string
  linkType: string
  fromType: string
  fromId: string
  toType: string
  toId: string
  workspaceId: string
  createdAt: string | null
  createdById: string | null
  source: string
  origin: string
  /** The endpoint row exists in its table, in any workspace. */
  fromExists: boolean
  toExists: boolean
  /** Both endpoints exist and sit in the link's own workspace. */
  sameWorkspace: boolean
  /** The reader's test: the endpoint resolves inside the link's workspace (and is not a tool approval). */
  fromResolves: boolean
  toResolves: boolean
  /** True/false for the task-owned link types (would list_task_links and the task screen return it); null for every other link type. */
  wouldBeReturnedByTaskLinkReaders: boolean | null
  /** Which read-parity sets named this id; empty when only the hidden scan found it. */
  parity: ParityOrigin[]
  /** The hidden-row scan found it (task-owned type, an endpoint the readers drop). */
  hiddenTaskLink: boolean
}

export type EntityLinksRowDetailStatus = {
  cap: number
  rows: EntityLinksRowDetail[]
  /** More rows qualified than `rows` holds. */
  truncated: boolean
  taskOwnedLinkTypes: readonly string[]
  /** Parity ids (legacy ids for onlyLegacy / originDrift) that name no entity_links row. */
  idsWithoutEntityLinksRow: string[]
  /** Set when the parity status itself failed, so there were no parity ids to look up. */
  parityError?: string
  /** Legacy rows with no entity_links twin, per legacy source (see LEGACY_SOURCES). `{ error }` if even the table presence check failed. */
  legacyOnly: LegacyOnlyStatus | { error: string }
}

type DetailRow = {
  id: string; link_type: string; from_type: string; from_id: string; to_type: string; to_id: string; workspace_id: string
  created_at: Date | string | null; created_by_id: string | null; source: string; origin: string
  from_exists: boolean | null; to_exists: boolean | null; same_workspace: boolean | null; from_resolves: boolean | null; to_resolves: boolean | null
}

/** Reads the capped ids out of a parity result, keeping which set (and family) named each one. */
export function collectParityIds(parity: EntityLinksReadParityStatus | { error: string } | undefined): { ids: Map<string, ParityOrigin[]>; error?: string } {
  const ids = new Map<string, ParityOrigin[]>()
  if (!parity) return { ids }
  if ("error" in parity) return { ids, error: parity.error }
  for (const [family, entry] of Object.entries(parity.families)) {
    for (const set of ["onlyLegacy", "onlyEntityLinks", "originDrift"] as const) {
      for (const id of entry.ids[set] ?? []) ids.set(id, [...(ids.get(id) ?? []), { family, set }])
    }
  }
  return { ids }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function fetchDetails(client: PoolClient, schema: string, ids: readonly string[]): Promise<Map<string, DetailRow>> {
  const found = new Map<string, DetailRow>()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { rows } = await client.query<DetailRow>(rowDetailSql.detail(schema, chunk.map((_, index) => `$${index + 1}::uuid`).join(", ")), chunk)
    for (const row of rows) found.set(row.id, row)
  }
  return found
}

/**
 * `parity` is the entityLinksReadParity result the same GET already computed (not recomputed here: that query needs the legacy tables).
 * Throws on a database error; the caller turns that into an `error` field, so the whole GET never fails because of this block.
 */
export async function getEntityLinksRowDetailStatus(client: PoolClient, schema: string, parity?: EntityLinksReadParityStatus | { error: string }): Promise<EntityLinksRowDetailStatus> {
  const { ids: parityIds, error: parityError } = collectParityIds(parity)
  const hidden = (await client.query<{ id: string }>(rowDetailSql.hiddenIds(schema))).rows.map((row) => row.id)
  const hiddenSet = new Set(hidden)

  // Parity rows first (they answer a question the owner already asked), then the hidden scan; one pass, deduplicated.
  const ordered = [...new Set([...parityIds.keys(), ...hidden])].filter((id) => UUID.test(id))
  const details = await fetchDetails(client, schema, ordered)
  const idsWithoutEntityLinksRow = [...parityIds.keys()].filter((id) => !details.has(id)).slice(0, ROW_DETAIL_CAP)

  const present = ordered.filter((id) => details.has(id))
  const rows = present.slice(0, ROW_DETAIL_CAP).map((id): EntityLinksRowDetail => {
    const row = details.get(id)!
    const fromResolves = row.from_resolves === true
    const toResolves = row.to_resolves === true
    return {
      id: row.id,
      linkType: row.link_type,
      fromType: row.from_type,
      fromId: row.from_id,
      toType: row.to_type,
      toId: row.to_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      createdById: row.created_by_id,
      source: row.source,
      origin: row.origin,
      fromExists: row.from_exists === true,
      toExists: row.to_exists === true,
      sameWorkspace: row.same_workspace === true,
      fromResolves,
      toResolves,
      wouldBeReturnedByTaskLinkReaders: TASK_OWNED_LINK_TYPES.includes(row.link_type) ? fromResolves && toResolves : null,
      parity: parityIds.get(id) ?? [],
      hiddenTaskLink: hiddenSet.has(id),
    }
  })
  return {
    cap: ROW_DETAIL_CAP,
    rows,
    truncated: present.length > ROW_DETAIL_CAP || hidden.length > ROW_DETAIL_CAP,
    taskOwnedLinkTypes: TASK_OWNED_LINK_TYPES,
    idsWithoutEntityLinksRow,
    ...(parityError ? { parityError } : {}),
    legacyOnly: await getLegacyOnlyStatus(client, schema).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
  }
}

// ── Legacy-only rows: legacy rows with no entity_links twin ──────────────────────────────────────────────────────────────────────────

/**
 * For each legacy link source, the rows that have no entity_links twin, so an owner can see WHAT the 116 drop preflight would refuse on
 * (or would silently tolerate) before choosing between a cleanup and a changed check. Since #547 unlinking deletes only the entity_links
 * row and leaves the legacy one, so such rows can exist.
 *
 * THE MATCHING RULE IS THE PARITY CHECK'S, not a new one. A legacy row is LIVE when it is in the parity status's own legacy set (both
 * endpoints exist in the link's workspace; readParitySetsSql(...).legacy), and a live row HAS A TWIN when the parity status's own mirror set
 * holds its (from, to type, to) (readParitySetsSql(...).mirror). So `legacyOnlyLiveCount` equals entityLinksReadParity onlyLegacy for the
 * same families, and that is the number the 116 preflight refuses on. A legacy row that is NOT live (an endpoint is gone) is never required
 * to have a twin by the preflight; it is still reported, with `blocksDropPreflight: false`, and has a twin when ANY entity_links row of the
 * mapped link type joins the same pair.
 *
 * A source whose table (or the pointer column) is gone reports `legacyDropped: true` and nothing else: 116 dropped it. Counts and metadata
 * only; each source is its own try/catch, so one failing source never hides the others.
 */
export const LEGACY_SOURCES = ["artifact_links", "solution_key_result_links", "opportunity_objective_links", "task_links", "opportunities.linked_key_result_id"] as const
export type LegacySource = (typeof LEGACY_SOURCES)[number]

type LegacySourceSpec = {
  /** Parity families whose legacy and mirror sets define live and twin for this source. */
  specs: readonly string[]
  /** The raw legacy rows: id, mapped link type (lt), endpoint types (ft, tt) and ids (f, t), workspace (ws), metadata. */
  raw: (s: string) => string
}

const LEGACY_SOURCE_SPECS: Record<LegacySource, LegacySourceSpec> = {
  artifact_links: {
    specs: ["artifactSolution", "artifactDecision"],
    raw: (s) => `SELECT l.id::text AS id, CASE l.linked_type WHEN 'SOLUTION' THEN 'ARTIFACT_ATTACHED_TO_SOLUTION' WHEN 'REVIEW_REQUEST' THEN 'ARTIFACT_SUPPORTS_DECISION' ELSE 'UNMAPPED_' || l.linked_type END AS lt,
      'ARTIFACT' AS ft, l.artifact_id AS f, l.linked_type AS tt, l.linked_id AS t, l.workspace_id AS ws, l.created_at, l.created_by_id::text AS created_by_id, l.source, NULL::text AS origin
      FROM "${s}"."artifact_links" AS l`,
  },
  solution_key_result_links: {
    specs: ["solutionKeyResult"],
    raw: (s) => `SELECT l.id::text AS id, 'SOLUTION_TARGETS_KEY_RESULT' AS lt, 'SOLUTION' AS ft, l.solution_id AS f, 'KEY_RESULT' AS tt, l.key_result_id AS t, l.workspace_id AS ws,
      l.created_at, l.created_by_id::text AS created_by_id, l.source, NULL::text AS origin FROM "${s}"."solution_key_result_links" AS l`,
  },
  opportunity_objective_links: {
    specs: ["opportunityObjective"],
    raw: (s) => `SELECT l.id::text AS id, 'OPPORTUNITY_TARGETS_OBJECTIVE' AS lt, 'OPPORTUNITY' AS ft, l.opportunity_id AS f, 'OBJECTIVE' AS tt, l.objective_id AS t, l.workspace_id AS ws,
      l.created_at, l.created_by_id::text AS created_by_id, l.source, l.origin::text AS origin FROM "${s}"."opportunity_objective_links" AS l`,
  },
  task_links: {
    specs: ["taskReferences", "taskCreatedFrom"],
    // A task link has no workspace of its own: the task's is the link's (the parity rule). DECISION is stored as REVIEW_REQUEST.
    raw: (s) => `SELECT l.id::text AS id, CASE WHEN l.linked_type IN ('COMMENT', 'AGENT_CONVERSATION') THEN 'TASK_CREATED_FROM' ELSE 'TASK_REFERENCES' END AS lt,
      'TASK' AS ft, l.task_id AS f, CASE WHEN l.linked_type = 'DECISION' THEN 'REVIEW_REQUEST' ELSE l.linked_type END AS tt, l.linked_id AS t,
      (SELECT tk.workspace_id FROM "${s}"."tasks" AS tk WHERE tk.id = l.task_id) AS ws,
      l.created_at, l.created_by_id::text AS created_by_id, l.source, NULL::text AS origin FROM "${s}"."task_links" AS l`,
  },
  "opportunities.linked_key_result_id": {
    specs: ["opportunityKeyResultPointer"],
    // The pointer has no row of its own: the legacy id is the opportunity's, and it carries no creation metadata.
    raw: (s) => `SELECT o.id::text AS id, 'OPPORTUNITY_TARGETS_KEY_RESULT' AS lt, 'OPPORTUNITY' AS ft, o.id AS f, 'KEY_RESULT' AS tt, o.linked_key_result_id AS t, o.workspace_id AS ws,
      NULL::timestamp AS created_at, NULL::text AS created_by_id, NULL::text AS source, NULL::text AS origin FROM "${s}"."opportunities" AS o WHERE o.linked_key_result_id IS NOT NULL`,
  },
}

export type LegacyOnlyRow = {
  /** The legacy row's id (the opportunity's id for the pointer). */
  legacyId: string
  /** The entity_links link type this row maps to. */
  entityLinkType: string
  fromType: string
  fromId: string
  toType: string
  toId: string
  workspaceId: string | null
  createdAt: string | null
  createdById: string | null
  source: string | null
  origin: string | null
  fromExists: boolean
  toExists: boolean
  sameWorkspace: boolean
  /** Both endpoints exist in the link's workspace: the parity check counts it, and the 116 preflight refuses on it. */
  blocksDropPreflight: boolean
  /** Always false here: these are the rows with no twin (by the parity rule for a live row, by the pair for a row that is not live). */
  entityLinksTwinPresent: false
  /** An entity_links row of the mapped type joins the same pair but is not live (for example in another workspace), so the preflight still counts the legacy row. */
  twinRowExistsButNotLive: boolean
  /** Link types of entity_links rows joining the same two endpoints in either direction under a DIFFERENT type or direction (a mapping mismatch, not a deleted link). */
  pairUnderOtherLinkTypes: string[]
}

export type LegacyOnlySourceStatus =
  | { error: string }
  | { legacyDropped: true; legacyTotalCount: 0; legacyLiveCount: 0; legacyOnlyCount: 0; legacyOnlyLiveCount: 0; legacyOnlyNotLiveCount: 0; rows: []; truncated: false }
  | {
      legacyDropped: false
      legacyTotalCount: number
      /** Live legacy rows. Equals the sum of the parity `legacyLive` of the source's families. */
      legacyLiveCount: number
      /** Legacy rows (live or not) with no twin. */
      legacyOnlyCount: number
      /** Live legacy rows with no twin: equals entityLinksReadParity onlyLegacy for the source's families, and is what the 116 preflight refuses on. */
      legacyOnlyLiveCount: number
      /** Legacy rows whose endpoint is gone and that have no twin: the preflight tolerates them. */
      legacyOnlyNotLiveCount: number
      /** At most ROW_DETAIL_CAP, rows that block the preflight first, then by id. */
      rows: LegacyOnlyRow[]
      truncated: boolean
    }

export type LegacyOnlyStatus = { cap: number; sources: Record<LegacySource, LegacyOnlySourceStatus> }

/** The CTE chain shared by the count and the row query of one source. */
export function legacyOnlyCte(schema: string, source: LegacySource): string {
  const spec = LEGACY_SOURCE_SPECS[source]
  const sets = spec.specs.map((name) => readParitySetsSql(name, schema))
  return `WITH raw AS MATERIALIZED (${spec.raw(schema)}),
    lv AS MATERIALIZED (SELECT x.id FROM (${sets.map((set) => set.legacy).join("\n UNION ALL\n ")}) AS x),
    m AS MATERIALIZED (${sets.map((set) => set.mirror).join("\n UNION ALL\n ")}),
    c AS MATERIALIZED (SELECT r.*, EXISTS (SELECT 1 FROM lv WHERE lv.id = r.id) AS is_live,
        EXISTS (SELECT 1 FROM m WHERE m.f = r.f AND m.tt = r.tt AND m.t = r.t) AS twin_live,
        EXISTS (SELECT 1 FROM "${schema}"."entity_links" AS e WHERE e.from_id = r.f AND e.link_type = r.lt AND e.to_id = r.t) AS twin_any
      FROM raw AS r),
    o AS MATERIALIZED (SELECT c.*, NOT (CASE WHEN c.is_live THEN c.twin_live ELSE c.twin_any END) AS legacy_only FROM c)`
}

export const legacyOnlySql = {
  counts: (schema: string, source: LegacySource): string => `${legacyOnlyCte(schema, source)}
    SELECT (SELECT count(*) FROM o)::text AS total, (SELECT count(*) FROM o WHERE is_live)::text AS live_n, (SELECT count(*) FROM o WHERE legacy_only)::text AS only_n,
      (SELECT count(*) FROM o WHERE legacy_only AND is_live)::text AS only_live_n`,
  rows: (schema: string, source: LegacySource): string => `${legacyOnlyCte(schema, source)}
    SELECT q.id, q.lt, q.ft, q.f::text AS f, q.tt, q.t::text AS t, q.ws::text AS ws, q.created_at, q.created_by_id, q.source, q.origin, q.is_live,
      ${endpoint(schema, "q.ft", "q.f", {})} AS from_exists, ${endpoint(schema, "q.tt", "q.t", {})} AS to_exists,
      ${endpointWorkspace(schema, "q.ft", "q.f")} = q.ws AND ${endpointWorkspace(schema, "q.tt", "q.t")} = q.ws AS same_workspace,
      (q.twin_any AND NOT q.twin_live) AS twin_not_live,
      ARRAY(SELECT DISTINCT e.link_type FROM "${schema}"."entity_links" AS e
        WHERE ((e.from_id = q.f AND e.to_id = q.t) OR (e.from_id = q.t AND e.to_id = q.f)) AND NOT (e.from_id = q.f AND e.link_type = q.lt AND e.to_id = q.t)
        ORDER BY 1 LIMIT 5) AS other_types
    FROM (SELECT * FROM o WHERE legacy_only ORDER BY is_live DESC, id LIMIT ${ROW_DETAIL_CAP + 1}) AS q
    ORDER BY q.is_live DESC, q.id`,
}

type LegacyOnlyDbRow = {
  id: string; lt: string; ft: string; f: string; tt: string; t: string; ws: string | null; created_at: Date | string | null; created_by_id: string | null
  source: string | null; origin: string | null; is_live: boolean; from_exists: boolean | null; to_exists: boolean | null; same_workspace: boolean | null
  twin_not_live: boolean; other_types: string[] | null
}

/** Which of the five legacy relations exist (catalog reads only, safe on DSQL and plain Postgres). Never throws for a missing table. */
async function presentLegacySources(client: PoolClient, schema: string): Promise<Set<LegacySource>> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('artifact_links', 'solution_key_result_links', 'opportunity_objective_links', 'task_links')`,
    [schema],
  )
  const column = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'opportunities' AND column_name = 'linked_key_result_id'`, [schema])
  const present = new Set<LegacySource>(tables.rows.map((row) => row.table_name as LegacySource))
  if (Number(column.rows[0]?.n ?? "0") > 0) present.add("opportunities.linked_key_result_id")
  return present
}

async function legacyOnlyForSource(client: PoolClient, schema: string, source: LegacySource): Promise<LegacyOnlySourceStatus> {
  const counts = (await client.query<{ total: string; live_n: string; only_n: string; only_live_n: string }>(legacyOnlySql.counts(schema, source))).rows[0]
  const found = (await client.query<LegacyOnlyDbRow>(legacyOnlySql.rows(schema, source))).rows
  const rows = found.slice(0, ROW_DETAIL_CAP).map((row): LegacyOnlyRow => ({
    legacyId: row.id,
    entityLinkType: row.lt,
    fromType: row.ft,
    fromId: row.f,
    toType: row.tt,
    toId: row.t,
    workspaceId: row.ws,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    createdById: row.created_by_id,
    source: row.source,
    origin: row.origin,
    fromExists: row.from_exists === true,
    toExists: row.to_exists === true,
    sameWorkspace: row.same_workspace === true,
    blocksDropPreflight: row.is_live,
    entityLinksTwinPresent: false,
    twinRowExistsButNotLive: row.twin_not_live,
    pairUnderOtherLinkTypes: row.other_types ?? [],
  }))
  return {
    legacyDropped: false,
    legacyTotalCount: Number(counts.total),
    legacyLiveCount: Number(counts.live_n),
    legacyOnlyCount: Number(counts.only_n),
    legacyOnlyLiveCount: Number(counts.only_live_n),
    legacyOnlyNotLiveCount: Number(counts.only_n) - Number(counts.only_live_n),
    rows,
    truncated: found.length > ROW_DETAIL_CAP,
  }
}

/** Per legacy source; a missing table is `legacyDropped: true`, a failing source is its own `{ error }`. */
export async function getLegacyOnlyStatus(client: PoolClient, schema: string): Promise<LegacyOnlyStatus> {
  const present = await presentLegacySources(client, schema)
  const sources = {} as Record<LegacySource, LegacyOnlySourceStatus>
  for (const source of LEGACY_SOURCES) {
    if (!present.has(source)) {
      sources[source] = { legacyDropped: true, legacyTotalCount: 0, legacyLiveCount: 0, legacyOnlyCount: 0, legacyOnlyLiveCount: 0, legacyOnlyNotLiveCount: 0, rows: [], truncated: false }
      continue
    }
    sources[source] = await legacyOnlyForSource(client, schema, source).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
  }
  return { cap: ROW_DETAIL_CAP, sources }
}
