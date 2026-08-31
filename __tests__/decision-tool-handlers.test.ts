import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockPrepare, mockPrepareRelease, mockAdmit, mockQueueRelease, mockFindRequest, mockListRequests, mockFindDecision } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockPrepareRelease: vi.fn(),
  mockAdmit: vi.fn(),
  mockQueueRelease: vi.fn(),
  mockFindRequest: vi.fn(),
  mockListRequests: vi.fn(),
  mockFindDecision: vi.fn(),
}))
vi.mock("@/lib/release-authorization", () => ({
  prepareReleaseRun: mockPrepareRelease,
  queueAuthorizedRelease: mockQueueRelease,
  unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() },
}))

vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ kind: "USER", userId: "user-1" }) }))
vi.mock("@/lib/now-commitment", () => ({
  prepareNowCommitment: mockPrepare,
  admitRoadmapItemToNow: mockAdmit,
}))
vi.mock("@/lib/db", () => ({
  default: () => ({
    reviewRequest: { findUnique: mockFindRequest, findMany: mockListRequests },
    decisionRecord: { findUnique: mockFindDecision },
  }),
}))

import { applyRecordedDecision, getReviewRequest, listReviewRequests, requestNowCommitment, requestReleaseAuthorization } from "@/lib/decision-tool-handlers"

describe("decision MCP handlers", () => {
  beforeEach(() => vi.resetAllMocks())

  it("returns the review request ID when preparing a NOW commitment", async () => {
    mockPrepare.mockResolvedValue({ requestId: "request-1", id: "revision-1", fingerprint: "abc" })

    const result = await requestNowCommitment({ itemId: "item-1" })

    expect(result.content[0].text).toContain("ID: request-1")
    expect(mockPrepare).toHaveBeenCalledWith("item-1", { requestedById: "user-1" })
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

  it("applies a NOW decision idempotently and returns the receipt ID", async () => {
    mockFindDecision.mockResolvedValue({ id: "decision-1", revision: { request: { gateType: "NOW_COMMITMENT", subjectId: "item-1" } } })
    mockAdmit.mockResolvedValue({ id: "receipt-1", receiptKey: "decision-1:ADMIT", status: "APPLIED" })

    const result = await applyRecordedDecision({ decisionId: "decision-1" })

    expect(result.content[0].text).toContain("ID: receipt-1")
    expect(mockAdmit).toHaveBeenCalledWith("item-1", "decision-1")
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
