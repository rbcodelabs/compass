/**
 * Server-side loaders for the workspace outcome tree and the Outcomes index (Phase 3C).
 *
 * Flat queries plus the in-memory join in outcome-tree.ts, like lib/canvas/data.ts:
 * one batch of workspace-scoped queries, then the link reads. There is no N+1 and no
 * parent-chain scoping.
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
 * A missing link table (migration 071 not applied) is NOT tolerated: the batch readers propagate the database error, so
 * these loaders throw and the page fails loudly through the normal server-component error path. Nothing here catches it.
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

  const objectiveOpportunityLinks = [...linkedObjectives].flatMap(([opportunityId, objectives]) =>
    objectives.map((objective) => ({ objectiveId: objective.id, opportunityId })),
  )
  const solutionKeyResultEdges = [...linkedKeyResults].flatMap(([solutionId, keyResults]) =>
    keyResults.map((keyResult) => ({ solutionId, keyResultId: keyResult.id })),
  )
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
    objectiveOpportunityLinks,
    solutionKeyResultEdges,
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

export type OutcomesIndexData = {
  rows: Array<{
    id: string
    title: string
    status: string | null
    cycle: { id: string; title: string } | null
    linkedOpportunityCount: number
  }>
}

/**
 * The lighter read for the flat Outcomes index: Objectives, their cycle chip and how many
 * Opportunities each is linked to. It skips Solutions, the Solution links and Key Result
 * detail, and it runs the SAME derivation as the tree (the builder with no solutions and
 * Key Results trimmed to the two ids the legacy fallback needs), so the counts agree with
 * the tree exactly. Same workspace scoping as the tree loader.
 */
export async function loadOutcomesIndex(prisma: AppPrismaClient, workspaceId: string): Promise<OutcomesIndexData> {
  const [objectiveRows, cycleRows, keyResultRows, opportunityRows] = await Promise.all([
    prisma.objective.findMany({ where: { workspaceId }, select: { id: true, title: true, status: true, sortOrder: true, createdAt: true, cycleId: true } }),
    prisma.oKRCycle.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
    // Only needed to map a legacy pointer to its Objective.
    prisma.keyResult.findMany({ where: { objective: { workspaceId } }, select: { id: true, objectiveId: true } }),
    prisma.opportunity.findMany({
      where: { workspaceId, status: { not: "ARCHIVED" } },
      select: { id: true, title: true, status: true, sortOrder: true, createdAt: true, linkedKeyResultId: true },
    }),
  ])
  const opportunityIds = opportunityRows.map((o) => o.id)
  const linkedObjectives = await getLinkedObjectivesByOpportunity(prisma, workspaceId, opportunityIds, { preverified: true })
  const objectiveOpportunityLinks = [...linkedObjectives].flatMap(([opportunityId, objectives]) =>
    objectives.map((objective) => ({ objectiveId: objective.id, opportunityId })),
  )
  const cycleById = new Map(cycleRows.map((c) => [c.id, { id: c.id, title: c.title }]))
  const tree = buildOutcomeTree({
    objectives: objectiveRows.map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      sortOrder: o.sortOrder,
      createdAt: ms(o.createdAt),
      cycle: (o.cycleId && cycleById.get(o.cycleId)) || null,
    })),
    keyResults: keyResultRows.map((kr) => ({ id: kr.id, objectiveId: kr.objectiveId, title: "", current: 0, target: 0, sortOrder: 0 })),
    opportunities: opportunityRows.map((o) => ({ id: o.id, title: o.title, status: o.status, sortOrder: o.sortOrder, createdAt: ms(o.createdAt) })),
    solutions: [],
    objectiveOpportunityLinks,
    solutionKeyResultEdges: [],
    legacyPointers: opportunityRows.flatMap((o) => (o.linkedKeyResultId ? [{ opportunityId: o.id, keyResultId: o.linkedKeyResultId }] : [])),
  })
  return {
    rows: tree.roots.map((root) => ({
      id: root.id,
      title: root.title,
      status: root.status,
      cycle: root.cycle,
      linkedOpportunityCount: root.linkedOpportunityCount,
    })),
  }
}
