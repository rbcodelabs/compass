import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockPrepare, mockPrepareBuilding, mockPrepareTracked, mockApplyBuilding, mockFreshBuilding, mockFreshPolicy, mockRecord, mockAdmit, mockQueueRelease, mockRequireEnforcement } = vi.hoisted(() => ({
  mockAuth: vi.fn(), mockPrepare: vi.fn(), mockPrepareBuilding: vi.fn(), mockPrepareTracked: vi.fn(), mockApplyBuilding: vi.fn(), mockFreshBuilding: vi.fn(), mockFreshPolicy: vi.fn(), mockRecord: vi.fn(), mockAdmit: vi.fn(), mockQueueRelease: vi.fn(), mockRequireEnforcement: vi.fn(),
}))
const prisma = {
  workspace: { findFirst: vi.fn() },
  roadmapItem: { findUnique: vi.fn() }, solution: { findUnique: vi.fn() },
  reviewRevision: { findUnique: vi.fn() },
  reviewOption: { findUnique: vi.fn() },
}
vi.mock("@/auth", () => ({ auth: mockAuth }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/now-commitment", () => ({ prepareNowCommitment: mockPrepare, admitRoadmapItemToNow: mockAdmit }))
vi.mock("@/lib/now-gate-runtime", () => ({ requireEffectiveNowEnforcement: mockRequireEnforcement }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: mockRecord }))
vi.mock("@/lib/tracked-decisions", () => ({ createTrackedDecisionRequest: mockPrepareTracked }))
vi.mock("@/lib/building-investment", () => ({ prepareBuildingInvestmentReview: mockPrepareBuilding, applyBuildingInvestmentDecision: mockApplyBuilding, ensureBuildingInvestmentRevisionFresh: mockFreshBuilding }))
vi.mock("@/lib/native-policy-activation", () => ({ applyNativePolicyActivationDecision: vi.fn(), ensureNativePolicyActivationRevisionFresh: mockFreshPolicy }))
vi.mock("@/lib/release-authorization", () => ({
  queueAuthorizedRelease: mockQueueRelease,
  unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { createTrackedDecisionAction, decideReviewAction, requestBuildingInvestmentAction, requestNowCommitmentAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

describe("review actions ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    mockFreshBuilding.mockResolvedValue({ stale: false }); mockFreshPolicy.mockResolvedValue({ stale: false })
  })

  it("authorizes NOW preparation against the item's canonical workspace", async () => {
    prisma.roadmapItem.findUnique.mockResolvedValue({ id: "item-1", workspaceId: "ws-2" })
    prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(requestNowCommitmentAction("ws-1", "item-1")).rejects.toThrow("Workspace not found")
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "ws-2" }) }))
    expect(mockRequireEnforcement).toHaveBeenCalledWith("ws-2")
    expect(mockPrepare).not.toHaveBeenCalled()
  })

  it("authorizes Building preparation against the Solution's canonical workspace", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", opportunity: { workspaceId: "ws-2" } })
    prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(requestBuildingInvestmentAction("ws-1", "solution-1")).rejects.toThrow("Workspace not found")
    expect(mockPrepareBuilding).not.toHaveBeenCalled()
  })

  it("authorizes a decision against the revision request workspace", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-2", subjectId: "item-1" } })
    prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })).rejects.toThrow("Workspace not found")
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "ws-2" }) }))
    expect(mockRecord).not.toHaveBeenCalled()
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

  it("applies an approved Building decision after the human record is committed", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-2", subjectId: "solution-1", gateType: "BUILDING_INVESTMENT" } })
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-2", members: [{ id: "member-1" }], organization: { members: [] } })
    prisma.reviewOption.findUnique.mockResolvedValue({ outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" })
    mockRecord.mockResolvedValue({ id: "decision-1" })
    await decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })
    expect(mockApplyBuilding).toHaveBeenCalledWith("solution-1", "decision-1")
  })

  it("lets a workspace member create a tracking-only decision request", async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", members: [{ id: "member-1" }], organization: { members: [] } })
    mockPrepareTracked.mockResolvedValue({ id: "revision-1", requestId: "request-1" })

    await expect(createTrackedDecisionAction({ workspaceId: "ws-1", subjectType: "DOC", subjectId: "doc-1", question: "Publish?", context: "Ready for review.", idempotencyKey: "00000000-0000-4000-8000-000000000001" }))
      .resolves.toEqual({ requestId: "request-1", revisionId: "revision-1" })
    expect(mockPrepareTracked).toHaveBeenCalledWith(expect.objectContaining({ requestedById: "user-1" }))
  })

  it("never applies a side effect for a tracking-only decision", async () => {
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-1", subjectId: "doc-1", gateType: "TRACKED_DECISION" } })
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", members: [{ id: "member-1" }], organization: { members: [] } })
    prisma.reviewOption.findUnique.mockResolvedValue({ outcomeClass: "APPROVE", continuationKey: "NO_ACTION" })
    mockRecord.mockResolvedValue({ id: "decision-1" })

    await decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "option-1" })

    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockApplyBuilding).not.toHaveBeenCalled()
    expect(mockQueueRelease).not.toHaveBeenCalled()
    expect(prisma.reviewOption.findUnique).not.toHaveBeenCalled()
  })
})
