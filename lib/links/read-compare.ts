/**
 * Shadow-compare for the entity_links read flip (ADR "One generic entity_links table", section 6 tail).
 *
 * PR A of the flip ships the machinery only. NO production read path calls this file yet; the readers keep reading the legacy tables.
 * Later PRs route each family's reader through `compareFamilyRead` while its `COMPASS_ENTITY_LINKS_<FAMILY>_READ` flag is `shadow`.
 *
 * Shape of a comparison:
 *   1. The legacy reader's result is normalised to `ComparableLink[]` (the `legacy*` functions below take the rows a legacy reader already
 *      holds; they never query a legacy table, because lib/typed-links.ts is the only module allowed to name two of them).
 *   2. The entity_links result for the same scope comes from the `readEntityLinks*` helpers below. Like lib/links/read-models.ts they start
 *      from the viewed workspace and drop every row whose endpoint is not a live row of THAT workspace (dangling, foreign, NULL-workspace),
 *      which is exactly what the workspace-filtered legacy readers show.
 *   3. `compareLinks` diffs the two sets and `recordReadCompare` counts a mismatch. Counts and ids only: never a title or any content.
 *
 * COMMENT task links are legacy-only by design (they are not an association) and are excluded from both sides.
 */
import type { AppTransactionClient } from "@/lib/db"
import { ENTITY_TYPE_ALIASES, type LinkableEntityType } from "@/lib/entity-types"
import { resolveEndpoints } from "@/lib/links/endpoints"
import { LINK_READ_FAMILIES, TASK_REFERENCE_TARGET_TYPES, getLinkReadMode, type LinkReadFamily, type LinkReadMode } from "@/lib/links/registry"

type Tx = AppTransactionClient

export type ComparableLink = {
  linkType: string
  fromType: LinkableEntityType
  fromId: string
  toType: LinkableEntityType
  toId: string
  /** Only set where the legacy table carries one (Opportunity-Objective). Compared only when both sides have it. */
  origin?: "DIRECT" | "LEGACY"
}

const SOLUTION_KEY_RESULT = "SOLUTION_TARGETS_KEY_RESULT"
const OPPORTUNITY_OBJECTIVE = "OPPORTUNITY_TARGETS_OBJECTIVE"
const OPPORTUNITY_KEY_RESULT = "OPPORTUNITY_TARGETS_KEY_RESULT"
const ARTIFACT_SOLUTION = "ARTIFACT_ATTACHED_TO_SOLUTION"
const ARTIFACT_DECISION = "ARTIFACT_SUPPORTS_DECISION"
const TASK_REFERENCES = "TASK_REFERENCES"

/** The link types of each family, in the order a comparison reports them. */
export const FAMILY_LINK_TYPES: Readonly<Record<LinkReadFamily, readonly string[]>> = Object.freeze({
  SOLUTION_KR: [SOLUTION_KEY_RESULT],
  OPPORTUNITY: [OPPORTUNITY_OBJECTIVE, OPPORTUNITY_KEY_RESULT],
  ARTIFACT: [ARTIFACT_SOLUTION, ARTIFACT_DECISION],
  TASK: [TASK_REFERENCES],
})

const ID_CAP = 20
const ID_CHUNK = 500

// ── Comparison ──────────────────────────────────────────────────────────────

export type ReadCompareResult = {
  family: LinkReadFamily
  legacyCount: number
  entityLinksCount: number
  matched: number
  /** Present in the legacy result only. */
  onlyLegacy: number
  /** Present in the entity_links result only. */
  onlyEntityLinks: number
  /** Present in both with a different origin (Opportunity-Objective only). */
  originDrift: number
  /** Capped `<fromId>><toId>` pairs per class. Ids only. */
  ids: { onlyLegacy: string[]; onlyEntityLinks: string[]; originDrift: string[] }
  ok: boolean
}

const keyOf = (link: ComparableLink) => `${link.linkType}|${link.fromType}|${link.fromId}|${link.toType}|${link.toId}`
const pairOf = (link: ComparableLink) => `${link.fromId}>${link.toId}`

/** Duplicates collapse: both sides are SETS of links (the legacy tables and entity_links both have a unique pair). */
function indexLinks(links: readonly ComparableLink[]): Map<string, ComparableLink> {
  return new Map(links.map((link) => [keyOf(link), link]))
}

export function compareLinks(family: LinkReadFamily, legacy: readonly ComparableLink[], entityLinks: readonly ComparableLink[]): ReadCompareResult {
  const left = indexLinks(legacy)
  const right = indexLinks(entityLinks)
  const ids = { onlyLegacy: [] as string[], onlyEntityLinks: [] as string[], originDrift: [] as string[] }
  const counts = { matched: 0, onlyLegacy: 0, onlyEntityLinks: 0, originDrift: 0 }
  const push = (bucket: keyof typeof ids, link: ComparableLink) => {
    counts[bucket] += 1
    if (ids[bucket].length < ID_CAP) ids[bucket].push(pairOf(link))
  }
  for (const [key, link] of left) {
    const other = right.get(key)
    if (!other) push("onlyLegacy", link)
    else if (link.origin && other.origin && link.origin !== other.origin) push("originDrift", link)
    else counts.matched += 1
  }
  for (const [key, link] of right) if (!left.has(key)) push("onlyEntityLinks", link)
  return {
    family,
    legacyCount: left.size,
    entityLinksCount: right.size,
    ...counts,
    ids,
    ok: counts.onlyLegacy + counts.onlyEntityLinks + counts.originDrift === 0,
  }
}

// ── Counters (in process; the durable source is lib/migrations/entity-links-read-parity.ts) ──────────

export type ReadCompareCounters = {
  compares: number
  mismatches: number
  onlyLegacy: number
  onlyEntityLinks: number
  originDrift: number
  /** The entity_links side threw; the legacy result was unaffected. */
  errors: number
  lastMismatchAt: string | null
  lastMismatchIds: ReadCompareResult["ids"] | null
}

const emptyCounters = (): ReadCompareCounters => ({ compares: 0, mismatches: 0, onlyLegacy: 0, onlyEntityLinks: 0, originDrift: 0, errors: 0, lastMismatchAt: null, lastMismatchIds: null })
const counters: Record<LinkReadFamily, ReadCompareCounters> = {
  SOLUTION_KR: emptyCounters(),
  OPPORTUNITY: emptyCounters(),
  ARTIFACT: emptyCounters(),
  TASK: emptyCounters(),
}

export function getReadCompareCounters(): Record<LinkReadFamily, ReadCompareCounters> {
  return Object.fromEntries(LINK_READ_FAMILIES.map((family) => [family, { ...counters[family] }])) as Record<LinkReadFamily, ReadCompareCounters>
}

export function resetReadCompareCounters(): void {
  for (const family of LINK_READ_FAMILIES) counters[family] = emptyCounters()
}

/** Counts a comparison and, on a mismatch, logs counts and capped ids (never content). */
export function recordReadCompare(result: ReadCompareResult): void {
  const entry = counters[result.family]
  entry.compares += 1
  if (result.ok) return
  entry.mismatches += 1
  entry.onlyLegacy += result.onlyLegacy
  entry.onlyEntityLinks += result.onlyEntityLinks
  entry.originDrift += result.originDrift
  entry.lastMismatchAt = new Date().toISOString()
  entry.lastMismatchIds = result.ids
  console.warn(
    "[entity-links read-compare] mismatch",
    JSON.stringify({ family: result.family, legacy: result.legacyCount, entityLinks: result.entityLinksCount, onlyLegacy: result.onlyLegacy, onlyEntityLinks: result.onlyEntityLinks, originDrift: result.originDrift, ids: result.ids }),
  )
}

/**
 * What a reader calls next to its legacy read. Mode `off` does nothing (the entity_links reader is not even invoked) and returns null.
 * In `shadow` and `on` it runs `readEntityLinks`, compares it with the legacy links the caller already holds, records the result and
 * returns it. It NEVER throws and never changes what the caller returns: a failing entity_links read is counted as an error.
 * Which side the caller serves is the caller's business (shadow: legacy; on: entity_links, PR B onwards).
 */
export async function compareFamilyRead(
  family: LinkReadFamily,
  input: { legacy: readonly ComparableLink[]; readEntityLinks: () => Promise<ComparableLink[]> },
): Promise<ReadCompareResult | null> {
  if (getLinkReadMode(family) === "off") return null
  try {
    const result = compareLinks(family, input.legacy, await input.readEntityLinks())
    recordReadCompare(result)
    return result
  } catch (error) {
    recordReadError(family, error)
    return null
  }
}

/** Counts a failed entity_links read (shadow: the comparison was skipped; on: the reader fell back to legacy). Error class name only. */
export function recordReadError(family: LinkReadFamily, error: unknown): void {
  counters[family].errors += 1
  console.warn("[entity-links read-compare] entity_links read failed", JSON.stringify({ family, error: error instanceof Error ? error.name : "unknown" }))
}

export function readModesByFamily(): Record<LinkReadFamily, LinkReadMode> {
  return Object.fromEntries(LINK_READ_FAMILIES.map((family) => [family, getLinkReadMode(family)])) as Record<LinkReadFamily, LinkReadMode>
}

// ── Legacy-side normalisers (pure: they take rows a legacy reader already holds) ─────────────────────────

export function legacySolutionKeyResultPairs(rows: readonly { solutionId: string; keyResultId: string }[]): ComparableLink[] {
  return rows.map((row) => ({ linkType: SOLUTION_KEY_RESULT, fromType: "SOLUTION", fromId: row.solutionId, toType: "KEY_RESULT", toId: row.keyResultId }))
}

export function legacyOpportunityObjectivePairs(rows: readonly { opportunityId: string; objectiveId: string; origin: string }[]): ComparableLink[] {
  return rows.map((row) => ({
    linkType: OPPORTUNITY_OBJECTIVE, fromType: "OPPORTUNITY", fromId: row.opportunityId, toType: "OBJECTIVE", toId: row.objectiveId,
    origin: row.origin === "DIRECT" ? "DIRECT" : "LEGACY",
  }))
}

/** The `opportunities.linked_key_result_id` column, one pointer per opportunity; NULL pointers are not links. */
export function legacyOpportunityKeyResultPointers(rows: readonly { id: string; linkedKeyResultId: string | null }[]): ComparableLink[] {
  return rows.flatMap((row): ComparableLink[] =>
    row.linkedKeyResultId ? [{ linkType: OPPORTUNITY_KEY_RESULT, fromType: "OPPORTUNITY" as const, fromId: row.id, toType: "KEY_RESULT" as const, toId: row.linkedKeyResultId }] : [],
  )
}

/** artifact_links rows; `linked_type` SOLUTION and REVIEW_REQUEST are the only mirrored spellings, anything else is not comparable. */
export function legacyArtifactLinks(rows: readonly { artifactId: string; linkedType: string; linkedId: string }[]): ComparableLink[] {
  return rows.flatMap((row): ComparableLink[] =>
    row.linkedType === "SOLUTION"
      ? [{ linkType: ARTIFACT_SOLUTION, fromType: "ARTIFACT" as const, fromId: row.artifactId, toType: "SOLUTION" as const, toId: row.linkedId }]
      : row.linkedType === "REVIEW_REQUEST"
        ? [{ linkType: ARTIFACT_DECISION, fromType: "ARTIFACT" as const, fromId: row.artifactId, toType: "REVIEW_REQUEST" as const, toId: row.linkedId }]
        : [],
  )
}

const isTaskTargetType = (value: string): value is (typeof TASK_REFERENCE_TARGET_TYPES)[number] => (TASK_REFERENCE_TARGET_TYPES as readonly string[]).includes(value)

/** The legacy `linked_type` spellings migration 097 mirrors: the eight direct types and DECISION. A stored spelling such as REVIEW_REQUEST is NOT a legacy value. */
const LEGACY_TASK_LINK_TYPES: Readonly<Record<string, (typeof TASK_REFERENCE_TARGET_TYPES)[number]>> = Object.freeze({
  OPPORTUNITY: "OPPORTUNITY", SOLUTION: "SOLUTION", ROADMAP_ITEM: "ROADMAP_ITEM", OBJECTIVE: "OBJECTIVE", KEY_RESULT: "KEY_RESULT",
  DOC: "DOC", EXPERIMENT: "EXPERIMENT", FEEDBACK_ITEM: "FEEDBACK_ITEM", DECISION: "REVIEW_REQUEST",
})

/**
 * task_links rows. Only the nine legacy spellings count (DECISION is a review request); COMMENT, SQUAD, a stray stored spelling such as
 * REVIEW_REQUEST and anything unknown are not mirrored and are excluded, exactly as migration 097 and the parity SQL exclude them.
 */
export function legacyTaskReferences(rows: readonly { taskId: string; linkedType: string; linkedId: string }[]): ComparableLink[] {
  return rows.flatMap((row): ComparableLink[] => {
    const stored = Object.prototype.hasOwnProperty.call(LEGACY_TASK_LINK_TYPES, row.linkedType) ? LEGACY_TASK_LINK_TYPES[row.linkedType] : null
    return stored ? [{ linkType: TASK_REFERENCES, fromType: "TASK", fromId: row.taskId, toType: stored, toId: row.linkedId }] : []
  })
}

// ── Liveness: the workspace-filtered view both sides are compared in ──────────────────────────────────────

/**
 * Keeps only links whose BOTH endpoints are live rows of `workspaceId`. A legacy reader that does not filter (a raw task_links read) is
 * passed through this too, so a dangling legacy row shows up as "absent" the way the flipped reader would show it, instead of as noise.
 */
export async function retainLiveEndpoints(tx: Tx, workspaceId: string, links: readonly ComparableLink[]): Promise<ComparableLink[]> {
  const needed = new Map<LinkableEntityType, Set<string>>()
  const need = (type: LinkableEntityType, id: string) => (needed.get(type) ?? needed.set(type, new Set()).get(type)!).add(id)
  for (const link of links) {
    need(link.fromType, link.fromId)
    need(link.toType, link.toId)
  }
  const live = new Map<LinkableEntityType, Set<string>>()
  for (const [type, ids] of needed) {
    const found = new Set<string>()
    for (let i = 0; i < ids.size; i += ID_CHUNK) {
      const resolved = await resolveEndpoints(tx, type, workspaceId, [...ids].slice(i, i + ID_CHUNK))
      for (const id of resolved.keys()) found.add(id)
    }
    live.set(type, found)
  }
  return links.filter((link) => live.get(link.fromType)?.has(link.fromId) && live.get(link.toType)?.has(link.toId))
}

// ── entity_links-side readers (workspace-filtered, scoped by ids, chunked, no row cap so a comparison is exact) ──────

type Scope = { fromIds?: readonly string[]; toIds?: readonly string[] }

async function entityLinkRows(tx: Tx, workspaceId: string, linkType: string, scope: Scope, toTypes?: readonly string[]): Promise<ComparableLink[]> {
  const column = scope.fromIds ? "fromId" : "toId"
  const ids = [...new Set((scope.fromIds ?? scope.toIds ?? []) as readonly string[])]
  const out: ComparableLink[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await tx.entityLink.findMany({
      where: { workspaceId, linkType, [column]: { in: ids.slice(i, i + ID_CHUNK) }, ...(toTypes ? { toType: { in: [...toTypes] } } : {}) },
      select: { linkType: true, fromType: true, fromId: true, toType: true, toId: true, origin: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    for (const row of rows) {
      out.push({
        linkType: row.linkType, fromType: row.fromType as LinkableEntityType, fromId: row.fromId, toType: row.toType as LinkableEntityType, toId: row.toId,
        origin: row.origin === "DIRECT" ? "DIRECT" : row.origin === "LEGACY" ? "LEGACY" : undefined,
      })
    }
  }
  return out
}

const withoutOrigin = (links: ComparableLink[]): ComparableLink[] => links.map(({ origin: _origin, ...rest }) => rest)

/** Solution <-> Key Result, from either end. */
export async function readEntityLinksSolutionKeyResult(tx: Tx, workspaceId: string, scope: { solutionIds?: readonly string[]; keyResultIds?: readonly string[] }): Promise<ComparableLink[]> {
  const rows = scope.solutionIds
    ? await entityLinkRows(tx, workspaceId, SOLUTION_KEY_RESULT, { fromIds: scope.solutionIds })
    : await entityLinkRows(tx, workspaceId, SOLUTION_KEY_RESULT, { toIds: scope.keyResultIds ?? [] })
  return retainLiveEndpoints(tx, workspaceId, withoutOrigin(rows))
}

/** Opportunity <-> Objective with origin. `origins: "DIRECT"` mirrors the canvas filter. */
export async function readEntityLinksOpportunityObjective(
  tx: Tx,
  workspaceId: string,
  scope: { opportunityIds?: readonly string[]; objectiveIds?: readonly string[]; origins?: "ALL" | "DIRECT" },
): Promise<ComparableLink[]> {
  const rows = scope.opportunityIds
    ? await entityLinkRows(tx, workspaceId, OPPORTUNITY_OBJECTIVE, { fromIds: scope.opportunityIds })
    : await entityLinkRows(tx, workspaceId, OPPORTUNITY_OBJECTIVE, { toIds: scope.objectiveIds ?? [] })
  const wanted = scope.origins === "DIRECT" ? rows.filter((row) => row.origin === "DIRECT") : rows
  return retainLiveEndpoints(tx, workspaceId, wanted)
}

/** The Opportunity -> Key Result pointer (OPPORTUNITY_TARGETS_KEY_RESULT), from either end. */
export async function readEntityLinksOpportunityKeyResultPointer(tx: Tx, workspaceId: string, scope: { opportunityIds?: readonly string[]; keyResultIds?: readonly string[] }): Promise<ComparableLink[]> {
  const rows = scope.opportunityIds
    ? await entityLinkRows(tx, workspaceId, OPPORTUNITY_KEY_RESULT, { fromIds: scope.opportunityIds })
    : await entityLinkRows(tx, workspaceId, OPPORTUNITY_KEY_RESULT, { toIds: scope.keyResultIds ?? [] })
  return retainLiveEndpoints(tx, workspaceId, withoutOrigin(rows))
}

/**
 * Artifact links of both types (solution, decision). Scope by artifact, or by the target (solution / decision ids). A Decision link is
 * kept only while its review request is a TRACKED_DECISION, the rule the legacy decision readers apply.
 */
export async function readEntityLinksArtifact(
  tx: Tx,
  workspaceId: string,
  scope: { artifactIds?: readonly string[]; solutionIds?: readonly string[]; decisionIds?: readonly string[] },
): Promise<ComparableLink[]> {
  let rows: ComparableLink[]
  if (scope.artifactIds) {
    rows = [...(await entityLinkRows(tx, workspaceId, ARTIFACT_SOLUTION, { fromIds: scope.artifactIds })), ...(await entityLinkRows(tx, workspaceId, ARTIFACT_DECISION, { fromIds: scope.artifactIds }))]
  } else if (scope.solutionIds) {
    rows = await entityLinkRows(tx, workspaceId, ARTIFACT_SOLUTION, { toIds: scope.solutionIds })
  } else {
    rows = await entityLinkRows(tx, workspaceId, ARTIFACT_DECISION, { toIds: scope.decisionIds ?? [] })
  }
  const live = await retainLiveEndpoints(tx, workspaceId, withoutOrigin(rows))
  const decisionIds = [...new Set(live.filter((link) => link.linkType === ARTIFACT_DECISION).map((link) => link.toId))]
  if (decisionIds.length === 0) return live
  const tracked = new Set<string>()
  for (let i = 0; i < decisionIds.length; i += ID_CHUNK) {
    const requests = await tx.reviewRequest.findMany({ where: { id: { in: decisionIds.slice(i, i + ID_CHUNK) }, workspaceId, gateType: "TRACKED_DECISION" }, select: { id: true } })
    for (const request of requests) tracked.add(request.id)
  }
  return live.filter((link) => link.linkType !== ARTIFACT_DECISION || tracked.has(link.toId))
}

/**
 * Task references (stored spelling REVIEW_REQUEST for a DECISION). Scope by task, or by one target type and its ids. COMMENT links are
 * legacy-only and never appear here.
 */
export async function readEntityLinksTaskReferences(
  tx: Tx,
  workspaceId: string,
  scope: { taskIds?: readonly string[]; target?: { type: string; ids: readonly string[] } },
): Promise<ComparableLink[]> {
  if (scope.taskIds) return retainLiveEndpoints(tx, workspaceId, withoutOrigin(await entityLinkRows(tx, workspaceId, TASK_REFERENCES, { fromIds: scope.taskIds })))
  const stored = scope.target ? (Object.prototype.hasOwnProperty.call(ENTITY_TYPE_ALIASES, scope.target.type) ? ENTITY_TYPE_ALIASES[scope.target.type] : scope.target.type) : null
  if (!scope.target || !stored || !isTaskTargetType(stored)) return []
  return retainLiveEndpoints(tx, workspaceId, withoutOrigin(await entityLinkRows(tx, workspaceId, TASK_REFERENCES, { toIds: scope.target.ids }, [stored])))
}
