/**
 * The link-type registry for the generic `entity_links` table (ADR "One generic entity_links
 * table for association links", section 4). A new association link type is ONE entry in
 * LINK_TYPES below plus (when it replaces a legacy table) a data migration; it needs no new table,
 * handler, tool or cleanup hook, because lib/links/service.ts, the generic MCP/REST tools and the
 * delete wiring all read this registry.
 *
 * Nothing in this file opens a database connection. Rules that need a query (eligibility, candidates) receive the
 * caller's transaction.
 *
 * A contract test (__tests__/links/registry-contract.test.ts) iterates every entry, so a type that
 * is missing a label, an authorize rule, a resolvable endpoint, a delete path or a parity entry
 * fails CI instead of failing in production.
 */
import type { z } from "zod"
import type { AppTransactionClient } from "@/lib/db"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { ENTITY_TYPE_VOCABULARY, type LinkableEntityType } from "@/lib/entity-types"
import { TypedLinkError, type LinkContext } from "@/lib/typed-links"

export type LinkOrigin = "DIRECT" | "LEGACY" | "MIGRATION"
export type LinkOperation = "link" | "unlink" | "list"
/** What the acting identity must be able to do to one endpoint. "none" means the endpoint is not checked at all. */
export type AuthAccess = "read" | "write" | "none"
export type AuthRule = { from: AuthAccess; to: AuthAccess }

/** A verified endpoint row, always loaded with a workspace filter by lib/links/endpoints.ts. */
export type LinkEndpoint = { type: LinkableEntityType; id: string; workspaceId: string; title: string }

export type LinkEligibilityInput = {
  tx: AppTransactionClient
  workspaceId: string
  from: LinkEndpoint
  to: LinkEndpoint
  ctx: LinkContext
}

/** Declarative description of a reciprocal getter field (wired into get_* tools by the UI phase). */
export type LinkSummarySpec = { field: string; select: readonly string[] }

/** One row the link picker offers, and one row the linked list shows. `status` is null for a type without one. */
export type LinkPickerItem = { type: LinkableEntityType; id: string; title: string; status: string | null }

export type LinkCandidatesInput = {
  tx: AppTransactionClient
  workspaceId: string
  /** Which end of the type the viewed entity is. The candidates are entities of the OTHER end. */
  side: "from" | "to"
  entityId: string
  query: string
  /** Entities already linked to the viewed one; never offered again. */
  excludeIds: readonly string[]
  limit: number
}

/** `canLink` false hides the add button (the viewed entity can take no new link); null means the type does not apply to the viewed entity at all. */
export type LinkCandidates = { canLink: boolean; items: LinkPickerItem[] } | null

/** Dual-write / backfill hooks for a type that replaces a legacy table. Declared here, implemented by phases 4-7. */
export type LegacyAdapter = {
  /** The module that owns the legacy table (the only place allowed to name it). */
  legacyModule: string
  /** The explicit-only backfill migration, or null for a new-only type (phase 4: no backfill, legacy stays the source of truth). */
  backfillMigration: string | null
  /**
   * "mirror": the legacy writer module writes this table first and mirrors into entity_links in the same transaction.
   * The generic service refuses direct writes and reads hide the type, because the table is a partial shadow
   * until a later phase backfills and flips reads.
   */
  mode: "mirror"
}

export type LinkTypeDef<A = unknown> = {
  /** UPPER_SNAKE `<FROM>_<VERB>_<TO>`, at most 60 characters, append-only: never rename or reuse a key. */
  key: string
  from: LinkableEntityType
  to: LinkableEntityType | readonly LinkableEntityType[]
  direction: "directed" | "symmetric"
  /**
   * The most links of this type one entity may hold: `from: "one"` means a `from` entity has at most one
   * (to-one), `to: "one"` the same for the `to` entity. Not database-enforced (no partial unique index on
   * DSQL): lib/links/service.ts enforces it and touches the entity row so concurrent writers conflict.
   */
  cardinality: { from: "one" | "many"; to: "one" | "many" }
  /** forward reads from the `from` entity ("Informed by"), inverse from the `to` entity ("Informs"). */
  labels: { forward: string; inverse: string }
  origins?: readonly LinkOrigin[]
  /** Validates the optional TEXT `attrs` column. Absent means the type takes no attrs. Never filtered in SQL. */
  attrs?: z.ZodType<A>
  /** "error" is for types whose legacy tool reports an existing link as a failure (link_task today). */
  duplicatePolicy: "idempotent" | "error"
  /** Which access the identity needs on each endpoint, per operation. Unlink checks the `from` endpoint only. */
  authorize(operation: LinkOperation): AuthRule
  /** Link-specific eligibility (study type, archived state, ...). Runs on link only, so existing links stay removable. */
  eligible?(input: LinkEligibilityInput): Promise<void>
  /**
   * What the shared picker (components/links/linked-entities-section.tsx) offers when linking from either end,
   * mirroring `eligible` so the picker never offers a pair the service would refuse. Absent means the type has no UI.
   */
  candidates?(input: LinkCandidatesInput): Promise<LinkCandidates>
  /** Feature flag. When false every mutation is refused and the type is hidden from reads and summaries. */
  isEnabled?(): boolean
  lifecycle: { onFromDeleted: "delete" | "block"; onToDeleted: "delete" | "block"; onArchive: "keep" }
  summaries: { onFrom?: LinkSummarySpec; onTo?: LinkSummarySpec }
  /** Participant, PM-interview and synthesis contexts. Default (and only value used today) is "deny". */
  restrictedContexts: "deny" | "allow"
  legacy?: LegacyAdapter
  /** Existing per-type tools/operations that stay as thin wrappers over this type. */
  compat?: { mcpTools: readonly string[]; restOps: readonly string[] }
}

/** Reads the endpoint types a def may point at as a list. */
export function toTypesOf(def: LinkTypeDef): readonly LinkableEntityType[] {
  return Array.isArray(def.to) ? (def.to as readonly LinkableEntityType[]) : [def.to as LinkableEntityType]
}

/** Write on the `from` entity, read on the `to` entity; unlink checks only `from`; list reads both. */
export const defaultAuthorize = (operation: LinkOperation): AuthRule =>
  operation === "link" ? { from: "write", to: "read" } : operation === "unlink" ? { from: "write", to: "none" } : { from: "read", to: "read" }

// ── EXPERIMENT_INFORMED_BY_STUDY (the first type; no legacy data) ───────────

export const LINKABLE_STUDY_TYPES: readonly string[] = ["CUSTOMER_INTERVIEW", "USABILITY_TEST"]

/**
 * An Experiment is informed by research studies. Rules (from the superseded PR #277):
 * same workspace; many-to-many; only CUSTOMER_INTERVIEW and USABILITY_TEST studies (PM_INTERVIEW is
 * excluded everywhere and reported as not found, EXTERNAL is not linkable); an archived study cannot get
 * a NEW link but existing links stay visible and removable; the research feature flag is required for
 * mutations and hides the type from reads and summaries; link and unlink are idempotent. Linking changes
 * no experiment status, assumption, study protocol or participant credential: the service writes the
 * link row and nothing else.
 */
const experimentInformedByStudy: LinkTypeDef = {
  key: "EXPERIMENT_INFORMED_BY_STUDY",
  from: "EXPERIMENT",
  to: "RESEARCH_STUDY",
  direction: "directed",
  cardinality: { from: "many", to: "many" },
  labels: { forward: "Informed by", inverse: "Informs" },
  duplicatePolicy: "idempotent",
  authorize: defaultAuthorize,
  isEnabled: isResearchCaptureEnabled,
  async eligible({ tx, workspaceId, to }) {
    const study = await tx.researchStudy.findFirst({
      where: { id: to.id, workspaceId },
      select: { studyType: true, status: true },
    })
    // PM_INTERVIEW studies are invisible to ordinary members everywhere (findMemberStudy), so they are "not found" here too.
    if (!study || study.studyType === "PM_INTERVIEW") throw new TypedLinkError("Research study not found.")
    if (!LINKABLE_STUDY_TYPES.includes(study.studyType)) {
      throw new TypedLinkError("Only customer interview and usability test studies can be linked to an experiment.", "INVALID")
    }
    if (study.status === "ARCHIVED") throw new TypedLinkError("Archived research studies cannot be linked to an experiment.", "INVALID")
  },
  async candidates({ tx, workspaceId, side, entityId, query, excludeIds, limit }) {
    const like = { contains: query.trim().slice(0, 255), mode: "insensitive" as const }
    if (side === "from") {
      const studies = await tx.researchStudy.findMany({
        where: { workspaceId, studyType: { in: [...LINKABLE_STUDY_TYPES] }, status: { not: "ARCHIVED" }, name: like, id: { notIn: [...excludeIds] } },
        select: { id: true, name: true, status: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: limit,
      })
      return { canLink: true, items: studies.map((study) => ({ type: "RESEARCH_STUDY" as const, id: study.id, title: study.name, status: study.status })) }
    }
    const study = await tx.researchStudy.findFirst({ where: { id: entityId, workspaceId }, select: { studyType: true, status: true } })
    if (!study || !LINKABLE_STUDY_TYPES.includes(study.studyType)) return null
    // An archived study keeps its links visible and removable but takes no new one.
    if (study.status === "ARCHIVED") return { canLink: false, items: [] }
    const experiments = await tx.experiment.findMany({
      where: { workspaceId, title: like, id: { notIn: [...excludeIds] } },
      select: { id: true, title: true, status: true },
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: limit,
    })
    return { canLink: true, items: experiments.map((experiment) => ({ type: "EXPERIMENT" as const, id: experiment.id, title: experiment.title, status: experiment.status })) }
  },
  lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" },
  summaries: {
    onFrom: { field: "linkedStudies", select: ["id", "name", "studyType", "status"] },
    onTo: { field: "linkedExperiments", select: ["id", "title", "status"] },
  },
  restrictedContexts: "deny",
  compat: { mcpTools: [], restOps: [] },
}

// ── SOLUTION_TARGETS_KEY_RESULT (phase 4: new-only mirror of the legacy table) ───────

/** Outside production the mirror is on so tests and E2E cover it; production needs COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR=1. */
export function isSolutionKeyResultMirrorEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return process.env.COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR !== "0"
  return process.env.COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR === "1"
}

/**
 * A Solution targets Key Results. the legacy Solution-Key Result table stays the source of truth and every read stays on
 * it: the legacy writer (linkSolutionToKeyResult / unlinkSolutionFromKeyResult in lib/typed-links.ts) mirrors
 * each link and unlink into entity_links inside its own transaction while the flag is on (lib/links/legacy-mirror.ts).
 * New-only: nothing is backfilled, so the mirror is a partial shadow and is not offered by reads, summaries or the
 * generic link tools. Same workspace, many-to-many, idempotent, matching the legacy rules.
 */
const solutionTargetsKeyResult: LinkTypeDef = {
  key: "SOLUTION_TARGETS_KEY_RESULT",
  from: "SOLUTION",
  to: "KEY_RESULT",
  direction: "directed",
  cardinality: { from: "many", to: "many" },
  labels: { forward: "Targets", inverse: "Targeted by" },
  duplicatePolicy: "idempotent",
  authorize: defaultAuthorize,
  isEnabled: isSolutionKeyResultMirrorEnabled,
  lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" },
  summaries: {},
  restrictedContexts: "deny",
  legacy: { legacyModule: "lib/typed-links.ts", backfillMigration: null, mode: "mirror" },
  compat: { mcpTools: ["link_solution_to_key_result", "unlink_solution_from_key_result"], restOps: ["linkSolutionKeyResult", "unlinkSolutionKeyResult"] },
}

// ── OPPORTUNITY_TARGETS_OBJECTIVE / OPPORTUNITY_TARGETS_KEY_RESULT (phase 5: mirror of the legacy Opportunity-Objective table and the KR pointer) ──

/** Outside production the mirror is on so tests and E2E cover it; production needs COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR=1. */
export function isOpportunityLinkMirrorEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return process.env.COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR !== "0"
  return process.env.COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR === "1"
}

/** The explicit-only backfill for both Opportunity types (lib/migrations/entity-links-opportunity-backfill.ts). */
export const OPPORTUNITY_LINKS_BACKFILL_MIGRATION = "095_entity_links_backfill_opportunity"

/**
 * An Opportunity targets Objectives. The legacy Opportunity-Objective table stays the source of truth and every read stays on it;
 * lib/typed-links.ts mirrors each write (link, unlink, and the origin changes between DIRECT and LEGACY) into entity_links in the
 * same transaction while the flag is on (lib/links/legacy-mirror.ts). `origin` keeps the legacy meaning: DIRECT is a link a person or
 * agent made, LEGACY is one derived from the opportunity's Key Result pointer. Migration 095 backfills the existing rows with their
 * origin, source, actor and created_at. Reads, summaries and the generic link tools ignore the type until a later phase flips reads.
 */
const opportunityTargetsObjective: LinkTypeDef = {
  key: "OPPORTUNITY_TARGETS_OBJECTIVE",
  from: "OPPORTUNITY",
  to: "OBJECTIVE",
  direction: "directed",
  cardinality: { from: "many", to: "many" },
  labels: { forward: "Targets", inverse: "Targeted by" },
  origins: ["DIRECT", "LEGACY"],
  duplicatePolicy: "idempotent",
  authorize: defaultAuthorize,
  isEnabled: isOpportunityLinkMirrorEnabled,
  lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" },
  summaries: {},
  restrictedContexts: "deny",
  legacy: { legacyModule: "lib/typed-links.ts", backfillMigration: OPPORTUNITY_LINKS_BACKFILL_MIGRATION, mode: "mirror" },
  compat: { mcpTools: ["link_opportunity_to_objective", "unlink_opportunity_from_objective"], restOps: ["linkOpportunityObjective", "unlinkOpportunityObjective"] },
}

/**
 * The Key Result an Opportunity is expected to move: the granularity opportunities.linked_key_result_id carries and the
 * Objective link cannot. The column stays the source of truth; every pointer write (set, clear, create, move of the Key Result)
 * mirrors here in the same transaction. An Opportunity has at most one (to-one on the `from` side), so a changed pointer replaces
 * the row. All rows are origin LEGACY: they are derived from the pointer, never made directly.
 */
const opportunityTargetsKeyResult: LinkTypeDef = {
  key: "OPPORTUNITY_TARGETS_KEY_RESULT",
  from: "OPPORTUNITY",
  to: "KEY_RESULT",
  direction: "directed",
  cardinality: { from: "one", to: "many" },
  labels: { forward: "Targets", inverse: "Targeted by" },
  origins: ["LEGACY"],
  duplicatePolicy: "idempotent",
  authorize: defaultAuthorize,
  isEnabled: isOpportunityLinkMirrorEnabled,
  lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" },
  summaries: {},
  restrictedContexts: "deny",
  legacy: { legacyModule: "lib/typed-links.ts", backfillMigration: OPPORTUNITY_LINKS_BACKFILL_MIGRATION, mode: "mirror" },
  compat: { mcpTools: ["link_opportunity_to_kr"], restOps: ["updateOpportunity"] },
}

// ── TASK_REFERENCES (phase 7: mirror of the legacy task_links table) ────────

/** Outside production the mirror is on so tests and E2E cover it; production needs COMPASS_ENTITY_LINKS_TASK_MIRROR=1 (fail-closed). */
export function isTaskLinkMirrorEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return process.env.COMPASS_ENTITY_LINKS_TASK_MIRROR !== "0"
  return process.env.COMPASS_ENTITY_LINKS_TASK_MIRROR === "1"
}

/** The explicit-only backfill for TASK_REFERENCES (lib/migrations/entity-links-task-backfill.ts). */
export const TASK_LINKS_BACKFILL_MIGRATION = "097_entity_links_backfill_task"

/**
 * The target types a TaskLink may name, as stored in entity_links.to_type. A task link calls a review request `DECISION`; the alias is
 * normalised (lib/entity-types.ts) so only REVIEW_REQUEST is ever stored. Squad is excluded on purpose (a Task's squad is its own column) and
 * COMMENT (a Doc comment a task was made from) is not a user-facing association, so it is not mirrored.
 */
export const TASK_REFERENCE_TARGET_TYPES = [
  "OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM", "REVIEW_REQUEST",
] as const satisfies readonly LinkableEntityType[]

/**
 * A Task references the objects it delivers or discusses: ONE type whose target varies (the ADR's `TASK_REFERENCES`), because the nine
 * legacy targets share every rule. The legacy task_links table stays the source of truth and every read stays on it; the legacy writers
 * (lib/task-link-writes.ts) mirror each link and unlink into entity_links in the same transaction while the flag is on, and migration 097
 * backfills the existing rows (source, actor and created_at copied). Many-to-many; a repeat link is an error in the legacy tool
 * (`duplicatePolicy: "error"`), but the mirror reconciles an existing row silently because the legacy row is the truth. Reads, summaries and
 * the generic link tools ignore the type until a later phase flips reads.
 */
const taskReferences: LinkTypeDef = {
  key: "TASK_REFERENCES",
  from: "TASK",
  to: TASK_REFERENCE_TARGET_TYPES,
  direction: "directed",
  cardinality: { from: "many", to: "many" },
  labels: { forward: "Linked to", inverse: "Linked tasks" },
  origins: ["DIRECT"],
  duplicatePolicy: "error",
  authorize: defaultAuthorize,
  isEnabled: isTaskLinkMirrorEnabled,
  lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" },
  summaries: {},
  restrictedContexts: "deny",
  legacy: { legacyModule: "lib/task-link-writes.ts", backfillMigration: TASK_LINKS_BACKFILL_MIGRATION, mode: "mirror" },
  compat: { mcpTools: ["link_task", "unlink_task", "list_task_links"], restOps: ["linkTaskResource", "unlinkTaskResource", "listTaskLinks"] },
}

/** Append-only. Add one entry per type; never edit or reuse a key. */
const DEFINITIONS: readonly LinkTypeDef[] = [experimentInformedByStudy, solutionTargetsKeyResult, opportunityTargetsObjective, opportunityTargetsKeyResult, taskReferences]

export const LINK_TYPES: Readonly<Record<string, LinkTypeDef>> = Object.freeze(
  Object.fromEntries(DEFINITIONS.map((def) => [def.key, def])),
)

export const LINK_TYPE_KEYS: readonly string[] = DEFINITIONS.map((def) => def.key)

export function getLinkType(key: string): LinkTypeDef | null {
  return Object.prototype.hasOwnProperty.call(LINK_TYPES, key) ? LINK_TYPES[key] : null
}

/** The def or a user-safe INVALID error that lists the known keys. */
export function requireLinkType(key: string): LinkTypeDef {
  const def = getLinkType(key)
  if (!def) throw new TypedLinkError(`Invalid link type "${key}". Known link types: ${LINK_TYPE_KEYS.join(", ")}.`, "INVALID")
  return def
}

/** A type behind a flag that is off is invisible to reads and refused for writes. */
export function isLinkTypeEnabled(def: LinkTypeDef): boolean {
  return def.isEnabled ? def.isEnabled() : true
}

/** Every enabled type in which `entityType` is an endpoint, with the side(s) it plays. */
export function linkTypesForEntity(entityType: LinkableEntityType): { def: LinkTypeDef; asFrom: boolean; asTo: boolean }[] {
  // A legacy-mirrored type is invisible to reads: the legacy table is still the source of truth.
  return DEFINITIONS.filter((def) => isLinkTypeEnabled(def) && !def.legacy).flatMap((def) => {
    const asFrom = def.from === entityType
    const asTo = toTypesOf(def).includes(entityType)
    return asFrom || asTo ? [{ def, asFrom, asTo }] : []
  })
}

/** Structural checks the contract test also runs, exported so a bad entry names itself in the failure. */
export function validateLinkTypeDef(def: LinkTypeDef): string[] {
  const problems: string[] = []
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(def.key) || def.key.length > 60) problems.push("key must be UPPER_SNAKE and at most 60 characters")
  const types: readonly string[] = [def.from, ...toTypesOf(def)]
  for (const type of types) if (!(ENTITY_TYPE_VOCABULARY as readonly string[]).includes(type)) problems.push(`unknown entity type ${type}`)
  if (!def.labels.forward.trim() || !def.labels.inverse.trim()) problems.push("labels.forward and labels.inverse are required")
  if (def.restrictedContexts !== "deny") problems.push("restrictedContexts must be deny until a reviewed exception exists")
  return problems
}
