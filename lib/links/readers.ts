/**
 * The entity_links READERS for the link families that replaced the legacy tables (ADR "One generic entity_links table", section 6).
 * entity_links is the only store: every reader here starts from the viewed workspace and drops each row whose endpoint is not a live
 * row of THAT workspace (dangling, foreign, NULL-workspace), so nothing outside the workspace is ever shown. Rows come back oldest
 * first, ties broken by id.
 *
 * COMMENT task links (the Doc comment a task was made from) are not an association and never lived in entity_links; they stay in
 * task_links (lib/task-link-writes.ts).
 */
import type { AppTransactionClient } from "@/lib/db"
import { ENTITY_TYPE_ALIASES, type LinkableEntityType } from "@/lib/entity-types"
import { resolveEndpoints } from "@/lib/links/endpoints"
import { TASK_REFERENCE_TARGET_TYPES } from "@/lib/links/registry"

type Tx = AppTransactionClient

/** One stored link, as a reader returns it. `id`, `source`, `createdById` and `createdAt` are the entity_links row's. */
export type LinkView = {
  id?: string
  linkType: string
  fromType: LinkableEntityType
  fromId: string
  toType: LinkableEntityType
  toId: string
  origin?: "DIRECT" | "LEGACY"
  source?: string
  createdById?: string | null
  createdAt?: Date
}

const SOLUTION_KEY_RESULT = "SOLUTION_TARGETS_KEY_RESULT"
const OPPORTUNITY_OBJECTIVE = "OPPORTUNITY_TARGETS_OBJECTIVE"
const OPPORTUNITY_KEY_RESULT = "OPPORTUNITY_TARGETS_KEY_RESULT"
const ARTIFACT_SOLUTION = "ARTIFACT_ATTACHED_TO_SOLUTION"
const ARTIFACT_DECISION = "ARTIFACT_SUPPORTS_DECISION"
const TASK_REFERENCES = "TASK_REFERENCES"
const ARTIFACT_EXPERIMENT = "ARTIFACT_ATTACHED_TO_EXPERIMENT"

const ID_CHUNK = 500

const isTaskTargetType = (value: string): value is (typeof TASK_REFERENCE_TARGET_TYPES)[number] => (TASK_REFERENCE_TARGET_TYPES as readonly string[]).includes(value)

// ── Liveness: the workspace-filtered view every reader returns ────────────────────────────────────────────

/**
 * Keeps only links whose BOTH endpoints are live rows of `workspaceId`, so a dangling, foreign or NULL-workspace endpoint is absent.
 */
export async function retainLiveEndpoints(tx: Tx, workspaceId: string, links: readonly LinkView[]): Promise<LinkView[]> {
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

// ── Readers (workspace-filtered, scoped by ids, chunked, no row cap) ──────────────────────────────────────────

type Scope = { fromIds?: readonly string[]; toIds?: readonly string[] }

async function entityLinkRows(tx: Tx, workspaceId: string, linkType: string, scope: Scope, toTypes?: readonly string[]): Promise<LinkView[]> {
  const column = scope.fromIds ? "fromId" : "toId"
  const ids = [...new Set((scope.fromIds ?? scope.toIds ?? []) as readonly string[])]
  const out: LinkView[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await tx.entityLink.findMany({
      where: { workspaceId, linkType, [column]: { in: ids.slice(i, i + ID_CHUNK) }, ...(toTypes ? { toType: { in: [...toTypes] } } : {}) },
      select: { id: true, linkType: true, fromType: true, fromId: true, toType: true, toId: true, origin: true, source: true, createdById: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    for (const row of rows) {
      out.push({
        id: row.id, source: row.source, createdById: row.createdById, createdAt: row.createdAt,
        linkType: row.linkType, fromType: row.fromType as LinkableEntityType, fromId: row.fromId, toType: row.toType as LinkableEntityType, toId: row.toId,
        origin: row.origin === "DIRECT" ? "DIRECT" : row.origin === "LEGACY" ? "LEGACY" : undefined,
      })
    }
  }
  return out
}

const withoutOrigin = (links: LinkView[]): LinkView[] => links.map(({ origin: _origin, ...rest }) => rest)

/** Solution <-> Key Result, from either end. */
export async function readEntityLinksSolutionKeyResult(tx: Tx, workspaceId: string, scope: { solutionIds?: readonly string[]; keyResultIds?: readonly string[] }): Promise<LinkView[]> {
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
): Promise<LinkView[]> {
  const rows = scope.opportunityIds
    ? await entityLinkRows(tx, workspaceId, OPPORTUNITY_OBJECTIVE, { fromIds: scope.opportunityIds })
    : await entityLinkRows(tx, workspaceId, OPPORTUNITY_OBJECTIVE, { toIds: scope.objectiveIds ?? [] })
  const wanted = scope.origins === "DIRECT" ? rows.filter((row) => row.origin === "DIRECT") : rows
  return retainLiveEndpoints(tx, workspaceId, wanted)
}

/** The Opportunity -> Key Result pointer (OPPORTUNITY_TARGETS_KEY_RESULT), from either end. */
export async function readEntityLinksOpportunityKeyResultPointer(tx: Tx, workspaceId: string, scope: { opportunityIds?: readonly string[]; keyResultIds?: readonly string[] }): Promise<LinkView[]> {
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
): Promise<LinkView[]> {
  let rows: LinkView[]
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

/** How many live Solution + Decision links each Artifact has (the `_count.links` figure list_artifacts reports). Artifacts with none are absent. */
export async function countEntityLinksByArtifact(tx: Tx, workspaceId: string, artifactIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (artifactIds.length === 0) return counts
  for (const link of await readEntityLinksArtifact(tx, workspaceId, { artifactIds })) counts.set(link.fromId, (counts.get(link.fromId) ?? 0) + 1)
  return counts
}

/**
 * Artifact <-> Experiment (ARTIFACT_ATTACHED_TO_EXPERIMENT, a native type: no legacy twin, so nothing to compare against). Scope by artifact
 * or by experiment ids. Rows are workspace-filtered, ids are chunked, and a link survives only while BOTH endpoints are live in the
 * workspace, so a dangling or drifted row never shows. The order is creation order, ties broken by id.
 */
export async function readEntityLinksArtifactExperiment(
  tx: Tx,
  workspaceId: string,
  scope: { artifactIds?: readonly string[]; experimentIds?: readonly string[] },
): Promise<LinkView[]> {
  const rows = scope.artifactIds
    ? await entityLinkRows(tx, workspaceId, ARTIFACT_EXPERIMENT, { fromIds: scope.artifactIds })
    : await entityLinkRows(tx, workspaceId, ARTIFACT_EXPERIMENT, { toIds: scope.experimentIds ?? [] })
  return retainLiveEndpoints(tx, workspaceId, withoutOrigin(rows))
}

/**
 * Task references (stored spelling REVIEW_REQUEST for a DECISION). Scope by task, or by one target type and its ids. COMMENT links are
 * legacy-only and never appear here.
 */
export async function readEntityLinksTaskReferences(
  tx: Tx,
  workspaceId: string,
  scope: { taskIds?: readonly string[]; target?: { type: string; ids: readonly string[] } },
): Promise<LinkView[]> {
  if (scope.taskIds) return retainLiveEndpoints(tx, workspaceId, withoutOrigin(await entityLinkRows(tx, workspaceId, TASK_REFERENCES, { fromIds: scope.taskIds })))
  const stored = scope.target ? (Object.prototype.hasOwnProperty.call(ENTITY_TYPE_ALIASES, scope.target.type) ? ENTITY_TYPE_ALIASES[scope.target.type] : scope.target.type) : null
  if (!scope.target || !stored || !isTaskTargetType(stored)) return []
  return retainLiveEndpoints(tx, workspaceId, withoutOrigin(await entityLinkRows(tx, workspaceId, TASK_REFERENCES, { toIds: scope.target.ids }, [stored])))
}
