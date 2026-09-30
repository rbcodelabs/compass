import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockRecord, mockQueueRelease, mockCreateTracked, mockReviseTracked } = vi.hoisted(() => ({
  mockAuth: vi.fn(), mockRecord: vi.fn(), mockQueueRelease: vi.fn(), mockCreateTracked: vi.fn(), mockReviseTracked: vi.fn(),
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
vi.mock("@/lib/tracked-decisions", () => ({
  createTrackedDecisionRequest: mockCreateTracked,
  reviseTrackedDecisionRequest: mockReviseTracked,
  recordDecisionNoAction: vi.fn(),
}))

import { createTrackedDecisionAction, decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

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

describe("createTrackedDecisionAction options", () => {
  const input = { workspaceId: "ws-1", subjectType: "SOLUTION" as const, subjectId: "solution-1", question: "Which plan?", context: "Pick one.", idempotencyKey: "00000000-0000-4000-8000-000000000001" }
  const options = [{ label: "Ship now", description: "Soon" }, { label: "Wait" }]

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", members: [{ id: "member-1" }], organization: { members: [] } })
    mockCreateTracked.mockResolvedValue({ requestId: "request-1", id: "rev-1" })
    mockReviseTracked.mockResolvedValue({ requestId: "request-1", id: "rev-2" })
  })

  it("passes options to a new request", async () => {
    await expect(createTrackedDecisionAction({ ...input, options })).resolves.toEqual({ requestId: "request-1", revisionId: "rev-1" })
    expect(mockCreateTracked).toHaveBeenCalledWith(expect.objectContaining({ options, idempotencyKey: input.idempotencyKey, requestedById: "user-1" }))
  })

  it("passes options, including an empty clearing list, to a revision", async () => {
    const revise = { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes needed." }
    await createTrackedDecisionAction({ ...input, options, revise })
    expect(mockReviseTracked).toHaveBeenLastCalledWith(expect.objectContaining({ options, ...revise, requestedById: "user-1" }))
    await createTrackedDecisionAction({ ...input, options: [], revise })
    expect(mockReviseTracked).toHaveBeenLastCalledWith(expect.objectContaining({ options: [] }))
  })

  it("leaves options undefined on a revision when none were sent, so the service inherits the prior ones", async () => {
    await createTrackedDecisionAction({ ...input, revise: { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes needed." } })
    expect(mockReviseTracked.mock.calls[0][0].options).toBeUndefined()
  })

  it("does not create anything for a user outside the workspace", async () => {
    prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(createTrackedDecisionAction({ ...input, options })).rejects.toThrow("Workspace not found")
    expect(mockCreateTracked).not.toHaveBeenCalled()
  })
})

describe("multi-question actions", () => {
  const input = { workspaceId: "ws-1", subjectType: "SOLUTION" as const, subjectId: "solution-1", question: "Plan", context: "Pick.", idempotencyKey: "00000000-0000-4000-8000-000000000001" }
  const questions = [{ question: "When?", options: [{ label: "Now" }, { label: "Later" }] }]

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", members: [{ id: "member-1" }], organization: { members: [] } })
    mockCreateTracked.mockResolvedValue({ requestId: "request-1", id: "rev-1" })
    mockReviseTracked.mockResolvedValue({ requestId: "request-1", id: "rev-2" })
    mockRecord.mockResolvedValue({ id: "decision-1" })
    prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { workspaceId: "ws-1", gateType: "TRACKED_DECISION" } })
  })

  it("passes questions to a new request and to a revision, including an empty clearing list", async () => {
    await createTrackedDecisionAction({ ...input, questions })
    expect(mockCreateTracked).toHaveBeenCalledWith(expect.objectContaining({ questions }))
    const revise = { requestId: "request-1", expectedDecisionId: "decision-1", reason: "Changes needed." }
    await createTrackedDecisionAction({ ...input, questions: [], revise })
    expect(mockReviseTracked).toHaveBeenLastCalledWith(expect.objectContaining({ questions: [] }))
    await createTrackedDecisionAction({ ...input, revise })
    expect(mockReviseTracked.mock.calls[1][0].questions).toBeUndefined()
  })

  it("forwards the per-question answers to the decision service", async () => {
    const answers = [{ questionIndex: 0, chosenOption: "Now" }]
    await decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "fp", optionId: "sub", answers })
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ optionId: "sub", answers }))
  })
})
