/**
 * Read-only read-parity status for GET /api/admin/migrate (ADR "One generic entity_links table", section 6 tail: shadow-compare before the
 * read flip). It answers, per family, "would a reader flipped to entity_links show the same links as the legacy reader?" by diffing, in SQL,
 * the LIVE legacy rows against the LIVE mirror rows. "Live" is what the workspace-filtered readers show: both endpoints exist in the link's
 * workspace (a dangling, foreign or NULL-workspace endpoint is absent). The same rules are in lib/links/read-compare.ts (the TypeScript
 * comparator readers will call in shadow mode); this module is the durable, instance-independent counter source for the status endpoint.
 *
 * Counts and capped ids only (no titles or content). Nothing here writes. Cost: each family reads its legacy table plus the mirror rows of
 * its link types once (entity_links has no index that leads with link_type, so that part is a scan filtered by the workspace index), so
 * poll it sparingly, like the entityLinks*Backfill statuses it sits next to.
 */
import type { PoolClient } from "pg"
import { getLinkReadMode, type LinkReadFamily, type LinkReadMode } from "@/lib/links/registry"

const ID_CAP = 20
/** Per-family cap on the parity query; a timeout surfaces as the status's {error} field, never a hung request. */
const STATEMENT_TIMEOUT_MS = 15_000
const num = (value: unknown) => Number(value ?? "0")

type SetSql = { legacy: string; mirror: string }
/** Each set is `SELECT f, tt, t, o, id`: from id, to type (stored spelling), to id, origin (or NULL when not compared), a row id to report. */

/** `EXISTS` of a live row of `type` with id `idExpr` in workspace `wsExpr`. One explicit branch per type, no computed table names. */
function live(s: string, type: string, idExpr: string, wsExpr: string): string {
  const t = (table: string) => `EXISTS (SELECT 1 FROM "${s}"."${table}" AS x WHERE x.id = ${idExpr} AND x.workspace_id = ${wsExpr})`
  switch (type) {
    case "SOLUTION": return t("solutions")
    case "OPPORTUNITY": return t("opportunities")
    case "OBJECTIVE": return t("objectives")
    case "ARTIFACT": return t("artifacts")
    case "TASK": return t("tasks")
    case "ROADMAP_ITEM": return t("roadmap_items")
    case "DOC": return t("docs")
    case "EXPERIMENT": return t("experiments")
    case "FEEDBACK_ITEM": return t("feedback")
    case "REVIEW_REQUEST": return t("review_requests")
    case "KEY_RESULT": return `EXISTS (SELECT 1 FROM "${s}"."key_results" AS x JOIN "${s}"."objectives" AS xo ON xo.id = x.objective_id WHERE x.id = ${idExpr} AND xo.workspace_id = ${wsExpr})`
    default: throw new Error(`entity-links-read-parity: no liveness rule for ${type}`)
  }
}

/** Legacy `linked_type` spelling -> stored `to_type`, the nine task-link targets (COMMENT and anything else are excluded by omission). */
const TASK_TARGETS: readonly { legacy: string; stored: string }[] = [
  { legacy: "OPPORTUNITY", stored: "OPPORTUNITY" },
  { legacy: "SOLUTION", stored: "SOLUTION" },
  { legacy: "ROADMAP_ITEM", stored: "ROADMAP_ITEM" },
  { legacy: "OBJECTIVE", stored: "OBJECTIVE" },
  { legacy: "KEY_RESULT", stored: "KEY_RESULT" },
  { legacy: "DOC", stored: "DOC" },
  { legacy: "EXPERIMENT", stored: "EXPERIMENT" },
  { legacy: "FEEDBACK_ITEM", stored: "FEEDBACK_ITEM" },
  { legacy: "DECISION", stored: "REVIEW_REQUEST" },
]

type Spec = { name: string; family: LinkReadFamily; sets: (s: string) => SetSql }

const mirror = (s: string, linkType: string, fromType: string, toType: string, origin: string, extra = "") =>
  `SELECT e.from_id AS f, e.to_type AS tt, e.to_id AS t, ${origin} AS o, e.id::text AS id FROM "${s}"."entity_links" AS e
   WHERE e.link_type = '${linkType}' AND ${live(s, fromType, "e.from_id", "e.workspace_id")} AND ${live(s, toType, "e.to_id", "e.workspace_id")}${extra}`

const SPECS: readonly Spec[] = [
  {
    name: "solutionKeyResult",
    family: "SOLUTION_KR",
    sets: (s) => ({
      legacy: `SELECT l.solution_id AS f, 'KEY_RESULT' AS tt, l.key_result_id AS t, NULL::text AS o, l.id::text AS id FROM "${s}"."solution_key_result_links" AS l
        WHERE ${live(s, "SOLUTION", "l.solution_id", "l.workspace_id")} AND ${live(s, "KEY_RESULT", "l.key_result_id", "l.workspace_id")}`,
      mirror: mirror(s, "SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "KEY_RESULT", "NULL::text"),
    }),
  },
  {
    name: "opportunityObjective",
    family: "OPPORTUNITY",
    sets: (s) => ({
      legacy: `SELECT l.opportunity_id AS f, 'OBJECTIVE' AS tt, l.objective_id AS t, l.origin::text AS o, l.id::text AS id FROM "${s}"."opportunity_objective_links" AS l
        WHERE ${live(s, "OPPORTUNITY", "l.opportunity_id", "l.workspace_id")} AND ${live(s, "OBJECTIVE", "l.objective_id", "l.workspace_id")}`,
      mirror: mirror(s, "OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "OBJECTIVE", "e.origin::text"),
    }),
  },
  {
    name: "opportunityKeyResultPointer",
    family: "OPPORTUNITY",
    sets: (s) => ({
      legacy: `SELECT o.id AS f, 'KEY_RESULT' AS tt, o.linked_key_result_id AS t, NULL::text AS o, o.id::text AS id FROM "${s}"."opportunities" AS o
        WHERE o.linked_key_result_id IS NOT NULL AND ${live(s, "KEY_RESULT", "o.linked_key_result_id", "o.workspace_id")}`,
      mirror: mirror(s, "OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", "KEY_RESULT", "NULL::text"),
    }),
  },
  {
    name: "artifactSolution",
    family: "ARTIFACT",
    sets: (s) => ({
      legacy: `SELECT l.artifact_id AS f, 'SOLUTION' AS tt, l.linked_id AS t, NULL::text AS o, l.id::text AS id FROM "${s}"."artifact_links" AS l
        WHERE l.linked_type = 'SOLUTION' AND ${live(s, "ARTIFACT", "l.artifact_id", "l.workspace_id")} AND ${live(s, "SOLUTION", "l.linked_id", "l.workspace_id")}`,
      mirror: mirror(s, "ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", "SOLUTION", "NULL::text"),
    }),
  },
  {
    name: "artifactDecision",
    family: "ARTIFACT",
    sets: (s) => ({
      legacy: `SELECT l.artifact_id AS f, 'REVIEW_REQUEST' AS tt, l.linked_id AS t, NULL::text AS o, l.id::text AS id FROM "${s}"."artifact_links" AS l
        WHERE l.linked_type = 'REVIEW_REQUEST' AND ${live(s, "ARTIFACT", "l.artifact_id", "l.workspace_id")} AND ${live(s, "REVIEW_REQUEST", "l.linked_id", "l.workspace_id")}
          AND EXISTS (SELECT 1 FROM "${s}"."review_requests" AS r WHERE r.id = l.linked_id AND r.gate_type = 'TRACKED_DECISION')`,
      mirror: mirror(s, "ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", "REVIEW_REQUEST", "NULL::text",
        ` AND EXISTS (SELECT 1 FROM "${s}"."review_requests" AS r WHERE r.id = e.to_id AND r.gate_type = 'TRACKED_DECISION')`),
    }),
  },
  {
    name: "taskReferences",
    family: "TASK",
    // A task link has no workspace of its own: it is live when the task and the target are in the SAME workspace.
    sets: (s) => ({
      legacy: TASK_TARGETS.map((target) => `SELECT l.task_id AS f, '${target.stored}' AS tt, l.linked_id AS t, NULL::text AS o, l.id::text AS id FROM "${s}"."task_links" AS l
        WHERE l.linked_type = '${target.legacy}' AND EXISTS (SELECT 1 FROM "${s}"."tasks" AS tk WHERE tk.id = l.task_id AND ${live(s, target.stored, "l.linked_id", "tk.workspace_id")})`).join("\n      UNION ALL\n      "),
      mirror: `SELECT e.from_id AS f, e.to_type AS tt, e.to_id AS t, NULL::text AS o, e.id::text AS id FROM "${s}"."entity_links" AS e
        WHERE e.link_type = 'TASK_REFERENCES' AND ${live(s, "TASK", "e.from_id", "e.workspace_id")}
          AND (${TASK_TARGETS.map((target) => `(e.to_type = '${target.stored}' AND ${live(s, target.stored, "e.to_id", "e.workspace_id")})`).join(" OR ")})`,
    }),
  },
]

export type ReadParityEntry = {
  legacyLive: number
  mirrorLive: number
  /** Live legacy rows with no live mirror row. A flipped reader would hide these links. */
  onlyLegacy: number
  /** Live mirror rows with no live legacy row. A flipped reader would show these extra links. */
  onlyEntityLinks: number
  /** In both, with a different origin (only compared where the legacy table has one). */
  originDrift: number
  /** Capped ids: legacy row ids for onlyLegacy and originDrift, entity_links ids for onlyEntityLinks. */
  ids: { onlyLegacy: string[]; onlyEntityLinks: string[]; originDrift: string[] }
}

export type EntityLinksReadParityStatus = {
  readModes: Record<LinkReadFamily, LinkReadMode>
  /** Zero across the board means every family would read identically from entity_links. */
  totalMismatches: number
  families: Record<string, ReadParityEntry & { family: LinkReadFamily }>
}

async function parityFor(client: PoolClient, schema: string, spec: Spec): Promise<ReadParityEntry> {
  const { legacy, mirror: mirrorSql } = spec.sets(schema)
  const absent = (a: string, b: string) => `NOT EXISTS (SELECT 1 FROM ${b} AS y WHERE y.f = ${a}.f AND y.tt = ${a}.tt AND y.t = ${a}.t)`
  const drift = `FROM l JOIN m ON m.f = l.f AND m.tt = l.tt AND m.t = l.t WHERE l.o IS NOT NULL AND m.o IS NOT NULL AND l.o <> m.o`
  const sql = `
    WITH l AS MATERIALIZED (${legacy}), m AS MATERIALIZED (${mirrorSql}),
      ol AS MATERIALIZED (SELECT l.* FROM l WHERE ${absent("l", "m")}),
      om AS MATERIALIZED (SELECT m.* FROM m WHERE ${absent("m", "l")})
    SELECT
      (SELECT count(*) FROM l)::text AS legacy_live,
      (SELECT count(*) FROM m)::text AS mirror_live,
      (SELECT count(*) FROM ol)::text AS only_legacy,
      ARRAY(SELECT ol.id FROM ol ORDER BY ol.id LIMIT ${ID_CAP}) AS only_legacy_ids,
      (SELECT count(*) FROM om)::text AS only_entity_links,
      ARRAY(SELECT om.id FROM om ORDER BY om.id LIMIT ${ID_CAP}) AS only_entity_links_ids,
      (SELECT count(*) ${drift})::text AS origin_drift,
      ARRAY(SELECT l.id ${drift} ORDER BY l.id LIMIT ${ID_CAP}) AS origin_drift_ids`
  // A slow query must not hang GET /api/admin/migrate: SET LOCAL lives only inside this transaction (no session state is left on the connection).
  let result
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    result = await client.query<Record<string, string | string[]>>(sql)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
  const row = result.rows[0]
  return {
    legacyLive: num(row.legacy_live),
    mirrorLive: num(row.mirror_live),
    onlyLegacy: num(row.only_legacy),
    onlyEntityLinks: num(row.only_entity_links),
    originDrift: num(row.origin_drift),
    ids: { onlyLegacy: row.only_legacy_ids as string[], onlyEntityLinks: row.only_entity_links_ids as string[], originDrift: row.origin_drift_ids as string[] },
  }
}

/** Throws if a table is missing; the caller turns that into an error field, like the other entityLinks* statuses. */
export async function getEntityLinksReadParityStatus(client: PoolClient, schema: string): Promise<EntityLinksReadParityStatus> {
  const families: EntityLinksReadParityStatus["families"] = {}
  let totalMismatches = 0
  for (const spec of SPECS) {
    const entry = await parityFor(client, schema, spec)
    totalMismatches += entry.onlyLegacy + entry.onlyEntityLinks + entry.originDrift
    families[spec.name] = { family: spec.family, ...entry }
  }
  return {
    readModes: { SOLUTION_KR: getLinkReadMode("SOLUTION_KR"), OPPORTUNITY: getLinkReadMode("OPPORTUNITY"), ARTIFACT: getLinkReadMode("ARTIFACT"), TASK: getLinkReadMode("TASK") },
    totalMismatches,
    families,
  }
}

export const READ_PARITY_SPEC_NAMES: readonly string[] = SPECS.map((spec) => spec.name)
// Exported for the unit test only: the SQL of one spec, so a test can assert the liveness rules without a database.
export const readParitySetsSql = (name: string, schema: string): SetSql => {
  const spec = SPECS.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`unknown read-parity spec ${name}`)
  return spec.sets(schema)
}
