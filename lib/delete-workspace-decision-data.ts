import getPrisma from "@/lib/db"

type Prisma = ReturnType<typeof getPrisma>

/**
 * Removes the decision, release, and capacity aggregates owned by a workspace.
 * DSQL has no foreign-key cascades, so every dependency is deleted explicitly
 * and each statement remains its own bounded transaction.
 */
export async function deleteWorkspaceDecisionData(prisma: Prisma, workspaceId: string): Promise<void> {
  const releaseScope = { releaseRun: { workspaceId } }
  const decisionScope = { decisionRecord: { workspaceId } }
  const applicationScope = { decision: { workspaceId } }
  const requestScope = { revision: { request: { workspaceId } } }
  const revisionScope = { request: { workspaceId } }
  const capacityScope = { plan: { workspaceId } }

  // Release outbox/task children must go before runs. Runs hold the optional
  // authorization decision reference, so they also precede ledger decisions.
  await prisma.releaseDispatch.deleteMany({
    where: { OR: [releaseScope, decisionScope] },
  })
  await prisma.releaseRunTask.deleteMany({ where: releaseScope })
  await prisma.releaseRun.deleteMany({ where: { workspaceId } })

  // Application receipts and capacity reservations can reference decisions or
  // roadmap items. Remove them before either parent aggregate.
  await prisma.decisionApplication.deleteMany({ where: applicationScope })
  await prisma.portfolioCapacityReservation.deleteMany({ where: capacityScope })
  await prisma.portfolioCapacityPlan.deleteMany({ where: { workspaceId } })

  await prisma.decisionRecord.deleteMany({ where: { workspaceId } })
  await prisma.reviewOption.deleteMany({ where: requestScope })

  // Break ReviewRequest.currentRevisionId before deleting immutable revisions.
  await prisma.reviewRequest.updateMany({
    where: { workspaceId },
    data: { currentRevisionId: null, updatedAt: new Date() },
  })
  await prisma.reviewRevision.deleteMany({ where: revisionScope })
  await prisma.reviewRequest.deleteMany({ where: { workspaceId } })
}
