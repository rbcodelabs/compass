/**
 * Server-side extras for the per-opportunity OST tab (see opportunity-chain.ts for the derivation).
 *
 * Batch reads only (no N+1), every row scoped by `workspaceId` on its own column (an Objective's Key Results through the
 * Objective). Which extras are read depends on the preset's link emphasis, like the picker option list: the data a
 * workspace holds and what a user may do never depend on the preset.
 */
import type { AppPrismaClient } from "@/lib/db"
import { getLinkedKeyResultsBySolution } from "@/lib/typed-links"
import type { ResolvedThinkingModel } from "./resolve"
import type { ChainObjectiveInput, ChainTaskInput } from "./opportunity-chain"

type SolutionRef = { id: string }
type OpportunityRef = {
  linkedObjectives: ReadonlyArray<{ id: string }>
  linkedKeyResult: { objective: { id: string } } | null
}

export type OpportunityChainExtras = {
  /** solutionId -> typed Key Results it targets (empty map entries omitted). */
  keyResultsBySolution: Map<string, Array<{ id: string; title: string; objectiveId: string }>>
  /** solutionId -> non-cancelled delivery tasks linked to it. */
  tasksBySolution: Map<string, ChainTaskInput[]>
  chainObjectives: ChainObjectiveInput[]
}

export async function loadOpportunityChainExtras(
  prisma: AppPrismaClient,
  workspaceId: string,
  model: Pick<ResolvedThinkingModel, "links">,
  opportunity: OpportunityRef,
  solutions: readonly SolutionRef[],
): Promise<OpportunityChainExtras> {
  const solutionIds = solutions.map((s) => s.id)
  const [keyResultsBySolution, taskLinks] = await Promise.all([
    solutionIds.length > 0 && model.links.solToKr !== "hidden"
      ? getLinkedKeyResultsBySolution(prisma, workspaceId, solutionIds, { preverified: true })
      : Promise.resolve(new Map<string, Array<{ id: string; title: string; objectiveId: string }>>()),
    solutionIds.length > 0
      ? prisma.taskLink.findMany({
          where: { linkedType: "SOLUTION", linkedId: { in: solutionIds }, task: { workspaceId, status: { not: "CANCELLED" } } },
          select: { linkedId: true, createdAt: true, task: { select: { id: true, title: true, status: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
  ])

  const tasksBySolution = new Map<string, ChainTaskInput[]>()
  for (const link of taskLinks) {
    const list = tasksBySolution.get(link.linkedId) ?? []
    list.push(link.task)
    tasksBySolution.set(link.linkedId, list)
  }

  // Objectives the chain can touch: typed parents, the legacy pointer's Objective, and chips' owners.
  const wantsObjectives = model.links.oppToObjective !== "hidden" || model.links.solToKr !== "hidden"
  const objectiveIds = new Set<string>()
  if (wantsObjectives) {
    for (const objective of opportunity.linkedObjectives) objectiveIds.add(objective.id)
    if (opportunity.linkedKeyResult) objectiveIds.add(opportunity.linkedKeyResult.objective.id)
    for (const keyResults of keyResultsBySolution.values()) for (const kr of keyResults) objectiveIds.add(kr.objectiveId)
  }
  const objectiveRows =
    objectiveIds.size > 0
      ? await prisma.objective.findMany({
          where: { workspaceId, id: { in: [...objectiveIds] } },
          select: {
            id: true,
            title: true,
            keyResults: {
              select: { id: true, title: true, current: true, target: true, unit: true },
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            },
          },
        })
      : []

  return { keyResultsBySolution, tasksBySolution, chainObjectives: objectiveRows }
}
