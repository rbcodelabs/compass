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
import type { EntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
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
  }
}
