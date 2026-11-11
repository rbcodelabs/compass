import { expect, it, vi } from "vitest"
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data"

it("sweeps Decision artifact links from entity_links before deleting their targets", async () => {
  const models = ["releaseDispatch", "releaseRunTask", "releaseRun", "decisionApplication", "portfolioCapacityReservation", "portfolioCapacityPlan", "decisionRecord", "reviewOption", "decisionEvidenceRef", "reviewRevision", "reviewRequest", "entityLink"]
  const prisma = Object.fromEntries(models.map((name) => [name, { deleteMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: "request-1" }]) }]))
  prisma.entityLink.findMany.mockResolvedValue([])
  await deleteWorkspaceDecisionData(prisma as unknown as Parameters<typeof deleteWorkspaceDecisionData>[0], "workspace-a")
  // Links go by endpoint, before the requests themselves.
  expect(prisma.entityLink.findMany.mock.calls[0][0].where.OR[0]).toEqual({ fromType: "REVIEW_REQUEST", fromId: { in: ["request-1"] } })
  expect(prisma.entityLink.findMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.reviewRequest.deleteMany.mock.invocationCallOrder[0])
})
