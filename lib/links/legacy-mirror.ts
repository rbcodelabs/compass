/**
 * The single writer of legacy-mirrored link types (ADR "One generic entity_links table", section 6, phases 4 and 5).
 *
 * Phase 6 adds the two Artifact link types (Solution, Decision) the same way; migration 096 backfills them.
 *
 * Phase 5 adds Opportunity <-> Objective (origin DIRECT/LEGACY preserved) and the Opportunity -> Key Result pointer. Unlike phase 4 they
 * are backfilled by the explicit-only migration 095 (lib/migrations/entity-links-opportunity-backfill.ts), and the same rules apply:
 * the legacy table / column is the source of truth, the mirror joins the legacy transaction, removal never depends on the flag, and
 * reads and the generic tools ignore both types.
 *
 * Solution <-> Key Result is "new-only": the legacy Solution-Key Result table stays the source of truth and every read
 * stays on it. lib/typed-links.ts writes the legacy row, then calls the functions below inside the SAME
 * transaction, so the mirror row and the legacy row commit or roll back together and neither can drift.
 * Nothing is backfilled, so entity_links holds a partial shadow (links written while the flag was on);
 * reads, summaries and the generic link tools therefore ignore the type until a later phase backfills and
 * flips reads. Rollback is the flag: with it off no new mirror rows are written and nothing reads them.
 *
 * This module is the only caller that passes `viaLegacyWriter` to lib/links/service.ts.
 */
import type { AppTransactionClient } from "@/lib/db"
import { normalizeEntityType } from "@/lib/entity-types"
import { TASK_REFERENCE_TARGET_TYPES, isLinkTypeEnabled, requireLinkType } from "@/lib/links/registry"
import { drainLinksFromEntities, drainLinksToEntities, linkEntities, unlinkEntities, unlinkFromEntity } from "@/lib/links/service"
import type { LinkContext } from "@/lib/typed-links"

const KEY = "SOLUTION_TARGETS_KEY_RESULT"

type Pair = { solutionId: string; keyResultId: string; workspaceId: string }

/** Mirrors a link (idempotent) while the flag is on. The endpoints were verified by the legacy writer in this transaction and are re-verified by the service. */
export async function mirrorSolutionTargetsKeyResult(tx: AppTransactionClient, input: Pair & { ctx: LinkContext }): Promise<void> {
  if (!isLinkTypeEnabled(requireLinkType(KEY))) return
  await linkEntities(tx, {
    linkType: KEY,
    fromId: input.solutionId,
    toId: input.keyResultId,
    expectedWorkspaceId: input.workspaceId,
    ctx: input.ctx,
    viaLegacyWriter: true,
  })
}

/**
 * Removes the mirror row regardless of the flag, so a legacy unlink never strands a mirror row written while it was on.
 * The service verifies only the Solution (`from`) endpoint, so a Key Result deleted since is still handled.
 */
export async function unmirrorSolutionTargetsKeyResult(tx: AppTransactionClient, input: Pair): Promise<void> {
  await unlinkEntities(tx, { linkType: KEY, fromId: input.solutionId, toId: input.keyResultId, expectedWorkspaceId: input.workspaceId, viaLegacyWriter: true })
}

// ── Opportunity <-> Objective (phase 5) ─────────────────────────────────────

const OPPORTUNITY_OBJECTIVE = "OPPORTUNITY_TARGETS_OBJECTIVE"
const OPPORTUNITY_KEY_RESULT = "OPPORTUNITY_TARGETS_KEY_RESULT"

type OpportunityObjectivePair = { opportunityId: string; objectiveId: string; workspaceId: string }

/**
 * Mirrors the legacy link's FINAL state (idempotent) while the flag is on: `origin` is the legacy row's origin after its own
 * create / flip / keep-DIRECT rule ran, so a DIRECT link survives a LEGACY write here exactly as it does in the legacy table.
 */
export async function mirrorOpportunityTargetsObjective(
  tx: AppTransactionClient,
  input: OpportunityObjectivePair & { origin: "DIRECT" | "LEGACY"; ctx: LinkContext },
): Promise<void> {
  if (!isLinkTypeEnabled(requireLinkType(OPPORTUNITY_OBJECTIVE))) return
  await linkEntities(tx, {
    linkType: OPPORTUNITY_OBJECTIVE,
    fromId: input.opportunityId,
    toId: input.objectiveId,
    expectedWorkspaceId: input.workspaceId,
    origin: input.origin,
    ctx: input.ctx,
    viaLegacyWriter: true,
    reconcileOrigin: true,
  })
}

/** Removes the mirror row regardless of the flag. A deleted Objective is handled: only the Opportunity is verified. */
export async function unmirrorOpportunityTargetsObjective(tx: AppTransactionClient, input: OpportunityObjectivePair): Promise<void> {
  await unlinkEntities(tx, { linkType: OPPORTUNITY_OBJECTIVE, fromId: input.opportunityId, toId: input.objectiveId, expectedWorkspaceId: input.workspaceId, viaLegacyWriter: true })
}

/**
 * The LEGACY mirror rows of one opportunity that the pointer no longer implies. `keepObjectiveIds` are the objectives whose legacy row
 * still exists after the legacy delete (the pointer's own, and any DIRECT one): their mirror rows stay whatever their mirrored origin.
 * Removal runs whatever the flag says, so a flag turned off never strands a stale row.
 */
export async function unmirrorStaleLegacyObjectiveLinks(
  tx: AppTransactionClient,
  input: { opportunityId: string; workspaceId: string; keepObjectiveIds: readonly string[] },
): Promise<void> {
  await unlinkFromEntity(tx, { linkType: OPPORTUNITY_OBJECTIVE, fromId: input.opportunityId, expectedWorkspaceId: input.workspaceId, exceptToIds: input.keepObjectiveIds, origin: "LEGACY" })
}

/**
 * The mirror of the committed drain after a Key Result is deleted (drainLegacyLinksForOpportunities): the LEGACY rows of these
 * opportunities, only those to `objectiveId` when given. Removal never depends on the flag.
 */
export async function drainMirroredLegacyObjectiveLinks(db: AppTransactionClient, opportunityIds: readonly string[], objectiveId?: string): Promise<number> {
  return drainLinksFromEntities(db, { linkType: OPPORTUNITY_OBJECTIVE, fromIds: opportunityIds, origin: "LEGACY", toId: objectiveId })
}

// ── Opportunity -> Key Result (the linked_key_result_id pointer, phase 5) ───

/**
 * Brings the pointer mirror in line with the column: any row to another Key Result (all rows when the pointer is cleared) is removed
 * whatever the flag says, so a pointer that moved while the flag was off cannot leave a stale row; the current pointer's row is written
 * (idempotent) only while the flag is on. The Key Result was verified in the workspace by the legacy writer in this transaction.
 */
export async function mirrorOpportunityKeyResultPointer(
  tx: AppTransactionClient,
  input: { opportunityId: string; keyResultId: string | null; workspaceId: string; ctx: LinkContext },
): Promise<void> {
  await unlinkFromEntity(tx, { linkType: OPPORTUNITY_KEY_RESULT, fromId: input.opportunityId, expectedWorkspaceId: input.workspaceId, exceptToIds: input.keyResultId ? [input.keyResultId] : undefined })
  if (!input.keyResultId || !isLinkTypeEnabled(requireLinkType(OPPORTUNITY_KEY_RESULT))) return
  await linkEntities(tx, {
    linkType: OPPORTUNITY_KEY_RESULT,
    fromId: input.opportunityId,
    toId: input.keyResultId,
    expectedWorkspaceId: input.workspaceId,
    origin: "LEGACY",
    ctx: input.ctx,
    viaLegacyWriter: true,
  })
}

// ── Artifact links (phase 6) ────────────────────────────────────────────────

const ARTIFACT_SOLUTION = "ARTIFACT_ATTACHED_TO_SOLUTION"
const ARTIFACT_DECISION = "ARTIFACT_SUPPORTS_DECISION"

/** artifact_links.linked_type -> the registry type that mirrors it. */
const ARTIFACT_LINK_KEYS = { SOLUTION: ARTIFACT_SOLUTION, REVIEW_REQUEST: ARTIFACT_DECISION } as const
export type ArtifactLinkedType = keyof typeof ARTIFACT_LINK_KEYS

type ArtifactPair = { linkedType: ArtifactLinkedType; artifactId: string; linkedId: string; workspaceId: string }

/**
 * Mirrors an artifact_links row (idempotent) while the flag is on. The legacy writer verified both endpoints (and, for a Decision, the
 * TRACKED_DECISION gate) in this transaction; the service re-verifies them. A Decision link points at the Artifact itself, never at a
 * revision (ADR-0010: live supporting material).
 */
export async function mirrorArtifactLink(tx: AppTransactionClient, input: ArtifactPair & { ctx: LinkContext }): Promise<void> {
  const key = ARTIFACT_LINK_KEYS[input.linkedType]
  if (!isLinkTypeEnabled(requireLinkType(key))) return
  await linkEntities(tx, {
    linkType: key,
    fromId: input.artifactId,
    toId: input.linkedId,
    expectedWorkspaceId: input.workspaceId,
    ctx: input.ctx,
    viaLegacyWriter: true,
  })
}

/** Removes the mirror row regardless of the flag, so a legacy unlink never strands a row written while it was on. Only the Artifact is verified. */
export async function unmirrorArtifactLink(tx: AppTransactionClient, input: ArtifactPair): Promise<void> {
  await unlinkEntities(tx, { linkType: ARTIFACT_LINK_KEYS[input.linkedType], fromId: input.artifactId, toId: input.linkedId, expectedWorkspaceId: input.workspaceId, viaLegacyWriter: true })
}

// ── Task <-> any target (the TASK_REFERENCES type, phase 7) ─────────────────

const TASK_REFERENCES = "TASK_REFERENCES"

/** A legacy task_links row, as the legacy writer holds it right after the write. */
type TaskLinkRow = { taskId: string; linkedType: string; linkedId: string; source?: string | null; createdById?: string | null }

/**
 * The entity_links target type of a legacy `linked_type`, or null when the row is not mirrored: `DECISION` is a review request, and
 * `COMMENT` (the Doc comment a task was made from) or anything unknown stays legacy-only.
 */
function taskReferenceTargetType(linkedType: string) {
  const normalized = normalizeEntityType(linkedType)
  return normalized && (TASK_REFERENCE_TARGET_TYPES as readonly string[]).includes(normalized) ? normalized : null
}

const asLinkSource = (source: string | null | undefined): LinkContext["source"] => (source === "MCP" || source === "API" ? source : "UI")

/**
 * Mirrors a legacy task link (idempotent) while the flag is on. `link` is the legacy row as just written, so source and actor are copied
 * from it. The task and the target were verified by the legacy writer in this transaction and are re-verified by the service.
 */
export async function mirrorTaskReference(tx: AppTransactionClient, input: { link: TaskLinkRow; workspaceId: string }): Promise<void> {
  const toType = taskReferenceTargetType(input.link.linkedType)
  if (!toType || !isLinkTypeEnabled(requireLinkType(TASK_REFERENCES))) return
  await linkEntities(tx, {
    linkType: TASK_REFERENCES,
    fromId: input.link.taskId,
    toId: input.link.linkedId,
    toType,
    expectedWorkspaceId: input.workspaceId,
    origin: "DIRECT",
    ctx: { source: asLinkSource(input.link.source), createdById: input.link.createdById ?? null },
    viaLegacyWriter: true,
  })
}

/** Removes the mirror row regardless of the flag, so a legacy unlink never strands a row written while it was on. Only the task is verified. */
export async function unmirrorTaskReference(tx: AppTransactionClient, input: { link: Pick<TaskLinkRow, "taskId" | "linkedType" | "linkedId">; workspaceId: string }): Promise<void> {
  if (!taskReferenceTargetType(input.link.linkedType)) return
  await unlinkEntities(tx, { linkType: TASK_REFERENCES, fromId: input.link.taskId, toId: input.link.linkedId, expectedWorkspaceId: input.workspaceId, viaLegacyWriter: true })
}

/**
 * The mirror of a legacy delete that removes every task link to one deleted target (deleteObjective / deleteKeyResult). Committed passes of
 * at most 500 links; run it after the delete commits (drainAfterParentDelete). Removal never depends on the flag.
 */
export async function drainMirroredTaskReferencesTo(db: AppTransactionClient, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  const toType = taskReferenceTargetType(input.linkedType)
  if (!toType) return 0
  return drainLinksToEntities(db, { linkType: TASK_REFERENCES, toType, toIds: input.linkedIds })
}
