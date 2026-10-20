/**
 * Read models over `entity_links` for the surfaces that show links: the reciprocal summaries on the
 * get_* tools and the shared LinkedEntitiesSection. Like lib/links/service.ts this is one of the few files
 * allowed to name the EntityLink model.
 *
 * Every read here starts from the viewed entity's own workspace and resolves the OTHER end with a
 * workspace-filtered query, so a dangling, drifted or foreign endpoint is dropped rather than shown. A type
 * behind a disabled feature flag is invisible (summaries are omitted, the view is null). Linked records keep
 * showing when they are archived: only NEW links are refused for them.
 */
import type { AppTransactionClient } from "@/lib/db"
import { resolveEndpoints } from "@/lib/links/endpoints"
import { normalizeEntityType, type LinkableEntityType } from "@/lib/entity-types"
import {
  isLinkTypeEnabled,
  linkTypesForEntity,
  requireLinkType,
  toTypesOf,
  type LinkPickerItem,
  type LinkTypeDef,
} from "@/lib/links/registry"
import { TypedLinkError } from "@/lib/typed-links"

type Tx = AppTransactionClient
type Row = Record<string, unknown> & { id: string }

/** Upper bound on links read for one entity in a summary or a view. The picker excludes the same set. */
const LINKED_READ_CAP = 200
const CANDIDATE_LIMIT = 50

/**
 * Loads display rows for the ids, in the workspace, with the fields a summary spec may select. One explicit
 * branch per summarised type (see lib/links/endpoints.ts for why delegates are never looked up by name).
 * PM interview studies are never returned: they are invisible to ordinary members everywhere.
 */
async function loadSummaryRows(tx: Tx, type: LinkableEntityType, workspaceId: string, ids: string[]): Promise<Row[] | null> {
  if (ids.length === 0) return []
  switch (type) {
    case "EXPERIMENT":
      return tx.experiment.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, title: true, status: true },
        orderBy: [{ title: "asc" }, { id: "asc" }],
      })
    case "RESEARCH_STUDY":
      return tx.researchStudy.findMany({
        where: { workspaceId, id: { in: ids }, studyType: { not: "PM_INTERVIEW" } },
        select: { id: true, name: true, studyType: true, status: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      })
    default:
      return null
  }
}

/** Entity types that have a summary loader; the registry contract test requires every spec's endpoint to be here. */
export const SUMMARISED_ENTITY_TYPES: readonly LinkableEntityType[] = ["EXPERIMENT", "RESEARCH_STUDY"]

function titleOf(type: LinkableEntityType, row: Row): string {
  return String(type === "RESEARCH_STUDY" ? row.name : row.title)
}

async function linkedIds(tx: Tx, def: LinkTypeDef, side: "from" | "to", workspaceId: string, entityId: string): Promise<string[]> {
  const links = await tx.entityLink.findMany({
    where: side === "from" ? { workspaceId, linkType: def.key, fromId: entityId } : { workspaceId, linkType: def.key, toId: entityId },
    select: { fromId: true, toId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: LINKED_READ_CAP,
  })
  return links.map((link) => (side === "from" ? link.toId : link.fromId))
}

function sideOf(def: LinkTypeDef, entityType: LinkableEntityType): "from" | "to" | null {
  if (def.from === entityType) return "from"
  return toTypesOf(def).includes(entityType) ? "to" : null
}

/**
 * Additive reciprocal getter summaries: `{ linkedStudies: [...] }` for an experiment, `{ linkedExperiments: [...] }`
 * for a study, keyed by each registry spec's `field`. Callers merge the result into their existing payload, so
 * existing fields never change. The caller authorizes the viewed entity first; callers in a restricted
 * (participant, PM interview, synthesis) context must not call this at all.
 */
export async function loadLinkSummaries(tx: Tx, input: { workspaceId: string; entityType: string; entityId: string }): Promise<Record<string, Row[]>> {
  const entityType = normalizeEntityType(input.entityType)
  if (!entityType) return {}
  const out: Record<string, Row[]> = {}
  for (const { def } of linkTypesForEntity(entityType)) {
    const side = sideOf(def, entityType)
    const spec = side === "from" ? def.summaries.onFrom : def.summaries.onTo
    if (!side || !spec) continue
    const otherType = side === "from" ? toTypesOf(def)[0] : def.from
    const ids = await linkedIds(tx, def, side, input.workspaceId, input.entityId)
    const rows = (await loadSummaryRows(tx, otherType, input.workspaceId, ids)) ?? []
    out[spec.field] = rows.map((row) => Object.fromEntries(spec.select.map((field) => [field, row[field]])) as Row)
  }
  return out
}

// ── Shared section view ─────────────────────────────────────────────────────

const NOUNS: Partial<Record<LinkableEntityType, { singular: string; plural: string }>> = {
  EXPERIMENT: { singular: "experiment", plural: "experiments" },
  RESEARCH_STUDY: { singular: "research study", plural: "research studies" },
}

function nounsFor(type: LinkableEntityType) {
  const known = NOUNS[type]
  if (known) return known
  const singular = type.toLowerCase().replaceAll("_", " ")
  return { singular, plural: `${singular}s` }
}

export type LinkedEntitiesView = {
  linkType: string
  side: "from" | "to"
  /** The registry label as read from the viewed entity ("Informed by" / "Informs"). */
  label: string
  otherType: LinkableEntityType
  otherNoun: string
  otherNounPlural: string
  linked: LinkPickerItem[]
  candidates: LinkPickerItem[]
  canLink: boolean
}

export type LinkedEntitiesViewInput = {
  workspaceId: string
  entityType: string
  entityId: string
  linkType: string
  /** Picker search text; applied to the candidates only. */
  query?: string
}

/**
 * The view model behind LinkedEntitiesSection, or null when the type is flagged off, does not apply to this
 * entity, or the entity is not in the workspace (all indistinguishable to the caller on purpose).
 */
export async function getLinkedEntitiesView(tx: Tx, input: LinkedEntitiesViewInput): Promise<LinkedEntitiesView | null> {
  const entityType = normalizeEntityType(input.entityType)
  if (!entityType) throw new TypedLinkError(`Unknown entity type "${input.entityType}".`, "INVALID")
  const def = requireLinkType(input.linkType)
  if (!isLinkTypeEnabled(def)) return null
  const side = sideOf(def, entityType)
  if (!side || !def.candidates) return null

  if (!(await resolveEndpoints(tx, entityType, input.workspaceId, [input.entityId])).has(input.entityId)) return null
  const ids = await linkedIds(tx, def, side, input.workspaceId, input.entityId)
  const candidates = await def.candidates({
    tx,
    workspaceId: input.workspaceId,
    side,
    entityId: input.entityId,
    query: input.query ?? "",
    excludeIds: ids,
    limit: CANDIDATE_LIMIT,
  })
  if (!candidates) return null

  const otherType = side === "from" ? toTypesOf(def)[0] : def.from
  const rows = (await loadSummaryRows(tx, otherType, input.workspaceId, ids)) ?? []
  const nouns = nounsFor(otherType)
  return {
    linkType: def.key,
    side,
    label: side === "from" ? def.labels.forward : def.labels.inverse,
    otherType,
    otherNoun: nouns.singular,
    otherNounPlural: nouns.plural,
    linked: rows.map((row) => ({ type: otherType, id: row.id, title: titleOf(otherType, row), status: typeof row.status === "string" ? row.status : null })),
    candidates: candidates.items,
    canLink: candidates.canLink,
  }
}
