import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockRecord, mockQueueRelease } = vi.hoisted(() => ({
  mockAuth: vi.fn(), mockRecord: vi.fn(), mockQueueRelease: vi.fn(),
}))
const prisma = {
  workspace: { findFirst: vi.fn() },
  roadmapItem: { findUnique: vi.fn() }, solution: { findUnique: vi.fn() },
  reviewRevision: { findUnique: vi.fn() },
  reviewOption: { findUnique: vi.fn() },
}
vi.mock("@/auth", () => ({ auth: mockAuth }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: mockRecord }))
vi.mock("@/lib/release-authorization", () => ({
  queueAuthorizedRelease: mockQueueRelease,
  unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

describe("review actions ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  })

  it("authorizes a decision against the revision request workspace", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-2", subjectId: "item-1" } })
    prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })).rejects.toThrow("Workspace not found")
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "ws-2" }) }))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it.each([
    "NOW_COMMITMENT",
    "NOW_POLICY_ACTIVATION",
    "BUILDING_INVESTMENT",
    "BUILDING_INVESTMENT_REVOCATION",
  ])("rejects retired %s reviews before auth or mutation", async (gateType) => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-legacy", request: { workspaceId: "ws-1", subjectId: "item-1", gateType } })
    await expect(decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-legacy", fingerprint: "fp", optionId: "option-1" })).rejects.toThrow("read-only")
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled()
    expect(mockRecord).not.toHaveBeenCalled()
    expect(prisma.reviewOption.findUnique).not.toHaveBeenCalled()
  })

  it("queues an approved release decision with the immutable source fingerprint", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({
      id: "rev-1",
      sourceFingerprint: "source-fp",
      request: { workspaceId: "ws-2", subjectId: "release-1", gateType: "RELEASE_AUTHORIZATION" },
    })
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-2", members: [{ id: "member-1" }], organization: { members: [] } })
    prisma.reviewOption.findUnique.mockResolvedValue({ outcomeClass: "APPROVE", continuationKey: "DISPATCH_RELEASE_RUN" })
    mockRecord.mockResolvedValue({ id: "decision-1" })
    mockQueueRelease.mockResolvedValue({ status: "QUEUED", dispatchId: "dispatch-1" })

    await decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })

    expect(mockQueueRelease).toHaveBeenCalledWith(
      "release-1",
      "decision-1",
      "source-fp",
      expect.objectContaining({ revalidate: expect.any(Function) }),
    )
  })
})
