import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockPrepare, mockRecord, mockAdmit } = vi.hoisted(() => ({
  mockAuth: vi.fn(), mockPrepare: vi.fn(), mockRecord: vi.fn(), mockAdmit: vi.fn(),
}))
const prisma = {
  workspace: { findFirst: vi.fn() },
  roadmapItem: { findUnique: vi.fn() },
  reviewRevision: { findUnique: vi.fn() },
  reviewOption: { findUnique: vi.fn() },
}
vi.mock("@/auth", () => ({ auth: mockAuth }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/now-commitment", () => ({ prepareNowCommitment: mockPrepare, admitRoadmapItemToNow: mockAdmit }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: mockRecord }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { decideReviewAction, requestNowCommitmentAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

describe("review actions ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  })

  it("authorizes NOW preparation against the item's canonical workspace", async () => {
    prisma.roadmapItem.findUnique.mockResolvedValue({ id: "item-1", workspaceId: "ws-2" })
    prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(requestNowCommitmentAction("ws-1", "item-1")).rejects.toThrow("Workspace not found")
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "ws-2" }) }))
    expect(mockPrepare).not.toHaveBeenCalled()
  })

  it("authorizes a decision against the revision request workspace", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-2", subjectId: "item-1" } })
    prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })).rejects.toThrow("Workspace not found")
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "ws-2" }) }))
    expect(mockRecord).not.toHaveBeenCalled()
  })
})
