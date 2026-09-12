import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockPrepareBuilding, mockApplyBuilding, mockPrepareRelease, mockQueueRelease, mockFindRequest, mockListRequests, mockFindDecision, mockApplyTracked } = vi.hoisted(() => ({
  mockPrepareBuilding: vi.fn(), mockApplyBuilding: vi.fn(),
  mockPrepareRelease: vi.fn(),
  mockQueueRelease: vi.fn(),
  mockFindRequest: vi.fn(),
  mockListRequests: vi.fn(),
  mockFindDecision: vi.fn(),
  mockApplyTracked: vi.fn(),
}))
vi.mock("@/lib/release-authorization", () => ({
  prepareReleaseRun: mockPrepareRelease,
  queueAuthorizedRelease: mockQueueRelease,
  unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() },
}))

vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ kind: "USER", userId: "user-1" }) }))
vi.mock("@/lib/building-investment", () => ({ prepareBuildingInvestmentReview: mockPrepareBuilding, applyBuildingInvestmentDecision: mockApplyBuilding }))
vi.mock("@/lib/tracked-decisions", () => ({ applyTrackedDecision: mockApplyTracked }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    reviewRequest: { findUnique: mockFindRequest, findMany: mockListRequests },
    decisionRecord: { findUnique: mockFindDecision },
  }),
}))

import { applyRecordedDecision, getReviewRequest, listReviewRequests, requestBuildingInvestment, requestReleaseAuthorization } from "@/lib/decision-tool-handlers"

describe("decision MCP handlers", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("prepares a Building investment review without taking the decision", async () => {
    mockPrepareBuilding.mockResolvedValue({ requestId: "request-1", id: "revision-1", fingerprint: "abc" })
    const result = await requestBuildingInvestment({ solutionId: "solution-1" })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrepareBuilding).toHaveBeenCalledWith("solution-1", { requestedById: "user-1" })
  })

  it("prepares an exact release authorization scope for human review", async () => {
    const scope = {
      workspaceId: "workspace-1", provider: "GITHUB" as const, repositoryOwner: "rbcodelabs",
      repositoryName: "compass", pullRequestNumber: 42, baseRef: "main",
      headSha: "a".repeat(40), targetEnvironment: "PRODUCTION" as const,
      releasePolicyId: "release-policy-v1", taskIds: ["task-1"],
    }
    mockPrepareRelease.mockResolvedValue({ status: "READY", releaseRunId: "run-1", requestId: "request-1", revisionId: "revision-1" })

    const result = await requestReleaseAuthorization(scope)

    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("request-1")
    expect(mockPrepareRelease).toHaveBeenCalledWith({ ...scope, requestedById: "user-1" })
  })

  it("returns the current immutable review packet", async () => {
    mockFindRequest.mockResolvedValue({ id: "request-1", state: "PENDING", gateType: "NOW_COMMITMENT", subjectType: "ROADMAP_ITEM", subjectId: "item-1" })

    const result = await getReviewRequest({ requestId: "request-1" })

    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("NOW_COMMITMENT")
  })

  it("lists review requests by workspace and state", async () => {
    mockListRequests.mockResolvedValue([{ id: "request-1", state: "PENDING", subjectId: "item-1", currentRevision: { title: "Commit item", fingerprint: "abc" } }])

    const result = await listReviewRequests({ workspaceId: "workspace-1", state: "PENDING" })

    expect(result.content[0].text).toContain("Commit item [PENDING]")
    expect(mockListRequests).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "workspace-1", state: "PENDING" } }))
  })

  it("applies an approved Building investment decision", async () => {
    mockFindDecision.mockResolvedValue({ id: "decision-1", revision: { request: { gateType: "BUILDING_INVESTMENT", subjectId: "solution-1" } } })
    mockApplyBuilding.mockResolvedValue({ id: "receipt-1", receiptKey: "building:1", status: "APPLIED" })
    const result = await applyRecordedDecision({ decisionId: "decision-1" })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockApplyBuilding).toHaveBeenCalledWith("solution-1", "decision-1")
  })

  // Tracking-only decisions (the ordinary workspace Decisions queue, created via
  // request_decision) always resolve to continuationKey NO_ACTION — applying one
  // must not mutate any product state, and must be reachable by a service/agent
  // actor per the tool's documented contract ("Service actors may apply but
  // cannot take decisions.").
  it("applies a tracked (NO_ACTION) decision and returns its durable receipt", async () => {
    mockFindDecision.mockResolvedValue({ id: "decision-1", revision: { request: { gateType: "TRACKED_DECISION", subjectId: "experiment-1" } } })
    mockApplyTracked.mockResolvedValue({ id: "receipt-1", receiptKey: "tracked-decision:decision-1:v1", status: "APPLIED" })
    const result = await applyRecordedDecision({ decisionId: "decision-1" })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockApplyTracked).toHaveBeenCalledWith("decision-1")
    // No BUILDING_INVESTMENT / RELEASE_AUTHORIZATION applicator should ever
    // run for a tracking-only decision.
    expect(mockApplyBuilding).not.toHaveBeenCalled()
    expect(mockQueueRelease).not.toHaveBeenCalled()
  })

  it("queues an authorized release through the durable outbox", async () => {
    mockFindDecision.mockResolvedValue({
      id: "decision-1",
      revision: {
        sourceFingerprint: "source-fp",
        request: { gateType: "RELEASE_AUTHORIZATION", subjectId: "release-1" },
      },
    })
    mockQueueRelease.mockResolvedValue({ status: "QUEUED", dispatchId: "dispatch-1" })

    const result = await applyRecordedDecision({ decisionId: "decision-1" })

    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("dispatch-1")
    expect(mockQueueRelease).toHaveBeenCalledWith(
      "release-1",
      "decision-1",
      "source-fp",
      expect.objectContaining({ revalidate: expect.any(Function) }),
    )
  })
})
