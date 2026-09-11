import { expect, it, vi } from "vitest"
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data"

it("removes only workspace Decision artifact links before deleting their targets", async () => {
  const models = ["releaseDispatch", "releaseRunTask", "releaseRun", "decisionApplication", "portfolioCapacityReservation", "portfolioCapacityPlan", "decisionRecord", "reviewOption", "decisionEvidenceRef", "reviewRevision", "reviewRequest", "artifactLink"]
  const prisma = Object.fromEntries(models.map((name) => [name, { deleteMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }]))
  await deleteWorkspaceDecisionData(prisma as unknown as Parameters<typeof deleteWorkspaceDecisionData>[0], "workspace-a")
  expect(prisma.artifactLink.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { workspaceId: "workspace-a", linkedType: "REVIEW_REQUEST" } })
  expect(prisma.artifactLink.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.reviewRequest.deleteMany.mock.invocationCallOrder[0])
})
