/**
 * Server-side loader for the workspace outcome tree (Phase 3C).
 *
 * Flat queries plus the in-memory join in outcome-tree.ts, like lib/canvas/data.ts:
 * one batch of workspace-scoped queries, then the two link reads. There is no N+1
 * and no parent-chain scoping.
 *
 * TENANT SCOPING. Every query is filtered by `workspaceId`, on the row's OWN column
 * (Objective and Solution carry one since migration 068), so a NULL or drifted row is
 * hidden rather than trusted through its parent. A Key Result has no workspace of its
 * own and is read through its Objective. Cycles are read by their own workspaceId, so
 * a cycle-bound Objective whose cycle is another workspace's (or gone) simply shows no
 * cycle chip. The links come from the tolerant batch readers in lib/typed-links.ts,
 * which return only links whose OTHER endpoint is in the workspace and degrade to "no
 * links" when the link table does not exist yet (the deploy-order tolerance already
 * defined there); they chunk their IN lists. Nothing here names a link model.
 *
 * Read-only: no writes, no capture, no dependence on the selected preset except the
 * `shape` handed to the builder.
 */
import type { AppPrismaClient } from "@/lib/db"
import { getLinkedKeyResultsBySolution, getLinkedObjectivesByOpportunity } from "@/lib/typed-links"
import {
  buildOutcomeTree,
  type BuildOutcomeTreeInput,
  type OutcomeTree,
  type OutcomeTreeShape,
} from "./outcome-tree"

const ms = (value: Date | null | undefined): number | undefined => (value ? value.getTime() : undefined)

export async function loadOutcomeTreeInput(
  prisma: AppPrismaClient,
  workspaceId: string,
  shape: OutcomeTreeShape = "outcome-rooted",
): Promise<BuildOutcomeTreeInput> {
  const [objectiveRows, cycleRows, keyResultRows, opportunityRows, solutionRows] = await Promise.all([
    prisma.objective.findMany({
      where: { workspaceId },
      select: { id: true, title: true, status: true, sortOrder: true, createdAt: true, cycleId: true, parentKeyResultId: true },
    }),
    prisma.oKRCycle.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
    // A Key Result is in the workspace of its Objective.
    prisma.keyResult.findMany({
      where: { objective: { workspaceId } },
      select: { id: true, objectiveId: true, title: true, current: true, target: true, unit: true, sortOrder: true, createdAt: true },
    }),
    // ARCHIVED never shows in the tree, so it is not even read.
    prisma.opportunity.findMany({
      where: { workspaceId, status: { not: "ARCHIVED" } },
      select: { id: true, title: true, status: true, sortOrder: true, createdAt: true, linkedKeyResultId: true },
    }),
    prisma.solution.findMany({
      where: { workspaceId },
      select: { id: true, opportunityId: true, title: true, status: true, sortOrder: true, createdAt: true },
    }),
  ])

  const opportunityIds = opportunityRows.map((o) => o.id)
  const solutionIds = solutionRows.map((s) => s.id)
  // The ids come from workspace-filtered reads above, so the readers may skip re-verifying them.
  const [linkedObjectives, linkedKeyResults] = await Promise.all([
    getLinkedObjectivesByOpportunity(prisma, workspaceId, opportunityIds, { preverified: true }),
    getLinkedKeyResultsBySolution(prisma, workspaceId, solutionIds, { preverified: true }),
  ])

  const cycleById = new Map(cycleRows.map((c) => [c.id, { id: c.id, title: c.title }]))

  return {
    shape,
    objectives: objectiveRows.map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      sortOrder: o.sortOrder,
      createdAt: ms(o.createdAt),
      cycle: (o.cycleId && cycleById.get(o.cycleId)) || null,
      parentKeyResultId: o.parentKeyResultId,
    })),
    keyResults: keyResultRows.map((kr) => ({
      id: kr.id,
      objectiveId: kr.objectiveId,
      title: kr.title,
      current: kr.current,
      target: kr.target,
      unit: kr.unit,
      sortOrder: kr.sortOrder,
      createdAt: ms(kr.createdAt),
    })),
    opportunities: opportunityRows.map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      sortOrder: o.sortOrder,
      createdAt: ms(o.createdAt),
    })),
    solutions: solutionRows.map((s) => ({
      id: s.id,
      opportunityId: s.opportunityId,
      title: s.title,
      status: s.status,
      sortOrder: s.sortOrder,
      createdAt: ms(s.createdAt),
    })),
    objectiveOpportunityLinks: [...linkedObjectives].flatMap(([opportunityId, objectives]) =>
      objectives.map((objective) => ({ objectiveId: objective.id, opportunityId })),
    ),
    solutionKeyResultEdges: [...linkedKeyResults].flatMap(([solutionId, keyResults]) =>
      keyResults.map((keyResult) => ({ solutionId, keyResultId: keyResult.id })),
    ),
    legacyPointers: opportunityRows.flatMap((o) =>
      o.linkedKeyResultId ? [{ opportunityId: o.id, keyResultId: o.linkedKeyResultId }] : [],
    ),
  }
}

export async function loadOutcomeTree(
  prisma: AppPrismaClient,
  workspaceId: string,
  shape: OutcomeTreeShape = "outcome-rooted",
): Promise<OutcomeTree> {
  return buildOutcomeTree(await loadOutcomeTreeInput(prisma, workspaceId, shape))
}
