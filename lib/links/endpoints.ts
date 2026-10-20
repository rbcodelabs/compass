/**
 * Endpoint resolution for generic links: given a vocabulary type, a workspace and some ids, return
 * the rows that really live in THAT workspace, with a display title. It follows the shape of
 * resolveCommentTarget / FollowableDefinition (resolve the owning workspace, resolve display) but is
 * transaction-scoped and always filters by workspace, so a caller cannot verify an endpoint without
 * also proving it belongs to the workspace.
 *
 * Link-specific eligibility (TRACKED_DECISION only, study type, archived, flags) is deliberately NOT
 * here: resolveCommentTarget returns null for non-TRACKED_DECISION review requests, but task links
 * accept any gate type, so the registry's `eligible` hook owns those rules.
 *
 * Indirect owners resolve through their parent (a Key Result through its Objective, an Assumption
 * through its Solution, a Research turn through its session's study). A row whose own workspace is
 * NULL (an unbackfilled Solution/Objective) never matches a workspace filter, so it fails closed.
 *
 * One explicit branch per type: model delegates are never looked up by a computed name.
 */
import type { AppTransactionClient } from "@/lib/db"
import { isDocsSyncEnabled, recordDocChange } from "@/lib/doc-sync"
import type { LinkableEntityType } from "@/lib/entity-types"
import type { LinkEndpoint } from "@/lib/links/registry"

type Tx = AppTransactionClient
type Found = { id: string; title: string }

async function find(tx: Tx, type: LinkableEntityType, workspaceId: string, ids: string[]): Promise<Found[]> {
  const id = { in: ids }
  switch (type) {
    case "OBJECTIVE":
      return tx.objective.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "KEY_RESULT":
      return tx.keyResult.findMany({ where: { id, objective: { workspaceId } }, select: { id: true, title: true } })
    case "OPPORTUNITY":
      return tx.opportunity.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "SOLUTION":
      return tx.solution.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "ASSUMPTION":
      return tx.assumption.findMany({ where: { id, solution: { workspaceId } }, select: { id: true, title: true } })
    case "EXPERIMENT":
      return tx.experiment.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "ROADMAP_ITEM":
      return tx.roadmapItem.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "FEEDBACK_ITEM":
      return tx.feedbackItem.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "TASK":
      return tx.task.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "DOC":
      return tx.doc.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "ARTIFACT":
      return tx.artifact.findMany({ where: { id, workspaceId }, select: { id: true, title: true } })
    case "RESEARCH_STUDY": {
      const rows = await tx.researchStudy.findMany({ where: { id, workspaceId }, select: { id: true, name: true } })
      return rows.map((row) => ({ id: row.id, title: row.name }))
    }
    case "REVIEW_REQUEST": {
      const rows = await tx.reviewRequest.findMany({ where: { id, workspaceId }, select: { id: true, currentRevision: { select: { title: true } } } })
      return rows.map((row) => ({ id: row.id, title: row.currentRevision?.title ?? "Review request" }))
    }
    case "METRIC": {
      const definitions = await tx.metricDefinition.findMany({ where: { id, workspaceId }, select: { id: true, currentRevisionId: true } })
      if (definitions.length === 0) return []
      const revisions = await tx.metricRevision.findMany({
        where: { workspaceId, id: { in: definitions.map((definition) => definition.currentRevisionId) } },
        select: { id: true, name: true },
      })
      const names = new Map(revisions.map((revision) => [revision.id, revision.name]))
      return definitions.map((definition) => ({ id: definition.id, title: names.get(definition.currentRevisionId) ?? "Metric" }))
    }
    case "RESEARCH_TURN": {
      const rows = await tx.researchTurn.findMany({ where: { id, session: { study: { workspaceId } } }, select: { id: true } })
      return rows.map((row) => ({ id: row.id, title: "Research turn" }))
    }
  }
}

/**
 * The subset of `ids` that exist in `workspaceId`, keyed by id. Missing, foreign and NULL-workspace
 * rows are simply absent, so "not found" and "not yours" are indistinguishable to the caller.
 */
export async function resolveEndpoints(tx: Tx, type: LinkableEntityType, workspaceId: string, ids: readonly string[]): Promise<Map<string, LinkEndpoint>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await find(tx, type, workspaceId, unique)
  return new Map(rows.map((row) => [row.id, { type, id: row.id, workspaceId, title: row.title }]))
}

/**
 * Bumps the endpoint's updatedAt inside the write transaction. DSQL detects write-write conflicts only,
 * so a to-one cardinality check (which READS the entity's other links) is made safe by putting the
 * entity row in the write set: two concurrent writers then conflict instead of both succeeding.
 * Returns false for a type without an updatedAt column; the contract test refuses a to-one
 * cardinality on such a type.
 */
export async function touchEndpoint(tx: Tx, type: LinkableEntityType, workspaceId: string, id: string): Promise<boolean> {
  switch (type) {
    case "OBJECTIVE":
      await tx.objective.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "KEY_RESULT":
      await tx.keyResult.updateMany({ where: { id, objective: { workspaceId } }, data: { updatedAt: new Date() } })
      return true
    case "OPPORTUNITY":
      await tx.opportunity.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "SOLUTION":
      await tx.solution.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "ASSUMPTION":
      await tx.assumption.updateMany({ where: { id, solution: { workspaceId } }, data: { updatedAt: new Date() } })
      return true
    case "EXPERIMENT":
      await tx.experiment.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "ROADMAP_ITEM":
      await tx.roadmapItem.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "FEEDBACK_ITEM":
      await tx.feedbackItem.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "TASK":
      await tx.task.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "DOC":
      await tx.doc.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      // The touch changes no content, title, parent or stored revision, so a doc with a revision needs no sync row.
      // A pre-revision doc derives its revision from updatedAt (`legacy:<updatedAt>`), which the touch did change.
      if (isDocsSyncEnabled()) {
        const touched = await tx.doc.findFirst({ where: { id, workspaceId }, select: { revision: true } })
        if (touched && touched.revision === null) await recordDocChange(tx, workspaceId, id, "UPSERT")
      }
      return true
    case "ARTIFACT":
      await tx.artifact.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "RESEARCH_STUDY":
      await tx.researchStudy.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } })
      return true
    case "REVIEW_REQUEST":
    case "METRIC":
    case "RESEARCH_TURN":
      return false
  }
}
