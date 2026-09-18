import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockPrepareRelease, mockQueueRelease, mockFindRequest, mockListRequests, mockFindDecision, mockApplyTracked, mockFindWorkspace, mockFindArtifacts } = vi.hoisted(() => ({
  mockPrepareRelease: vi.fn(),
  mockQueueRelease: vi.fn(),
  mockFindRequest: vi.fn(),
  mockListRequests: vi.fn(),
  mockFindDecision: vi.fn(),
  mockApplyTracked: vi.fn(),
  mockFindWorkspace: vi.fn(),
  mockFindArtifacts: vi.fn(),
}))
vi.mock("@/lib/release-authorization", () => ({
  prepareReleaseRun: mockPrepareRelease,
  queueAuthorizedRelease: mockQueueRelease,
  unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() },
}))

vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ kind: "USER", userId: "user-1" }) }))
vi.mock("@/lib/tracked-decisions", () => ({ applyTrackedDecision: mockApplyTracked }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    reviewRequest: { findUnique: mockFindRequest, findMany: mockListRequests },
    decisionRecord: { findUnique: mockFindDecision },
    workspace: { findUnique: mockFindWorkspace },
    artifact: { findMany: mockFindArtifacts },
  }),
}))

import { applyRecordedDecision, getReviewRequest, listReviewRequests, requestReleaseAuthorization } from "@/lib/decision-tool-handlers"

describe("decision MCP handlers", () => {
  beforeEach(() => { vi.resetAllMocks() })

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

  // The Building-investment gate is retired: its rows survive for audit, but
  // there is no applicator left to mint a fresh receipt against one.
  it("refuses to apply a retired Building investment decision", async () => {
    mockFindDecision.mockResolvedValue({ id: "decision-1", revision: { request: { gateType: "BUILDING_INVESTMENT", subjectId: "solution-1" } } })
    const result = await applyRecordedDecision({ decisionId: "decision-1" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("does not have an applicator")
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
    // No RELEASE_AUTHORIZATION applicator should ever run for a tracking-only
    // decision.
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

describe("decision review deep links", () => {
  const ENV_KEYS = ["VERCEL_ENV", "VERCEL_BRANCH_URL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_APP_URL"] as const
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

  beforeEach(() => {
    vi.resetAllMocks()
    ENV_KEYS.forEach((key) => delete process.env[key])
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    mockFindWorkspace.mockResolvedValue({ slug: "compass", organization: { slug: "rbcodelabs" } })
    mockFindArtifacts.mockResolvedValue([])
  })

  afterEach(() => ENV_KEYS.forEach((key) => {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }))

  it("returns a review URL on a single review request", async () => {
    mockFindRequest.mockResolvedValue({ id: "request-1", workspaceId: "workspace-1", state: "PENDING", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: "key-1" })

    const result = await getReviewRequest({ requestId: "request-1" })

    const url = "https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-1"
    expect(result.content[0].text).toContain(`URL: ${url}`)
    expect((result.structuredContent.data as { reviewUrl: string }).reviewUrl).toBe(url)
  })

  it("attaches a review URL to every listed review request", async () => {
    mockListRequests.mockResolvedValue([
      { id: "request-1", state: "PENDING", subjectId: "item-1", currentRevision: { title: "Commit item", fingerprint: "abc" } },
      { id: "request-2", state: "DECIDED", subjectId: "item-2", currentRevision: { title: "Ship it", fingerprint: "def" } },
    ])

    const result = await listReviewRequests({ workspaceId: "workspace-1" })

    expect(result.content[0].text).toContain("URL: https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-1")
    expect(result.content[0].text).toContain("URL: https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-2")
    const { requests } = result.structuredContent.data as { requests: { reviewUrl: string }[] }
    expect(requests.map((request) => request.reviewUrl)).toEqual([
      "https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-1",
      "https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-2",
    ])
    // One workspace lookup for the whole page, not one per row.
    expect(mockFindWorkspace).toHaveBeenCalledTimes(1)
  })

  it("uses the declared scope workspace for a release authorization review", async () => {
    mockPrepareRelease.mockResolvedValue({ status: "READY", releaseRunId: "run-1", requestId: "request-1", revisionId: "revision-1" })

    const result = await requestReleaseAuthorization({
      workspaceId: "workspace-1", provider: "GITHUB", repositoryOwner: "rbcodelabs",
      repositoryName: "compass", pullRequestNumber: 42, baseRef: "main",
      headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
      releasePolicyId: "release-policy-v1", taskIds: ["task-1"],
    })

    expect(result.content[0].text).toContain("URL: https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/request-1")
    expect(mockFindWorkspace).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "workspace-1" } }))
  })

  it("omits the link instead of failing when the workspace cannot be resolved", async () => {
    mockFindWorkspace.mockResolvedValue(null)
    mockFindRequest.mockResolvedValue({ id: "request-1", workspaceId: "workspace-1", state: "PENDING", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: "key-1" })

    const result = await getReviewRequest({ requestId: "request-1" })

    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).not.toContain("URL:")
    expect((result.structuredContent.data as { reviewUrl: string | null }).reviewUrl).toBeNull()
  })

  it("still reports a prepared review as successful when the deployment origin is unconfigured", async () => {
    // Missing config only. The review WAS created, so reporting a failure would
    // be a lie that makes the agent retry an already-durable gate.
    process.env.VERCEL_ENV = "production"
    delete process.env.NEXT_PUBLIC_APP_URL
    mockPrepareRelease.mockResolvedValue({ status: "READY", releaseRunId: "run-1", requestId: "request-1", revisionId: "revision-1" })

    const result = await requestReleaseAuthorization({
      workspaceId: "workspace-1", provider: "GITHUB", repositoryOwner: "rbcodelabs",
      repositoryName: "compass", pullRequestNumber: 42, baseRef: "main",
      headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
      releasePolicyId: "release-policy-v1", taskIds: ["task-1"],
    })

    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain("request-1")
    expect(result.content[0].text).not.toContain("URL:")
    expect((result.structuredContent.data as { reviewUrl: string | null }).reviewUrl).toBeNull()
  })

  // Regression: buildReviewUrl used a bare `catch { return null }`, which
  // swallowed an *unsafe configured* origin (non-HTTPS, credentials, malformed)
  // exactly as if the origin were merely absent. lib/compass-url.ts's contract
  // is explicit that only CompassUrlNotConfiguredError may degrade to a null
  // link — a bad configured origin must abort, the same way every feedback
  // mutation already does (see "feedback mutation safety").
  it.each([
    ["a single review request", () => getReviewRequest({ requestId: "request-1" })],
    ["a listed page of review requests", () => listReviewRequests({ workspaceId: "workspace-1" })],
  ])("propagates an unsafe configured origin instead of silently dropping the link on %s", async (_name, invoke) => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.example.com"
    mockFindRequest.mockResolvedValue({ id: "request-1", workspaceId: "workspace-1", state: "PENDING", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: "key-1" })
    mockListRequests.mockResolvedValue([{ id: "request-1", state: "PENDING", subjectId: "item-1", currentRevision: { title: "Commit item", fingerprint: "abc" } }])

    await expect(invoke()).rejects.toThrow(/HTTPS|invalid/i)
  })

  // requestReleaseAuthorization wraps its whole body in a try/catch that turns
  // any throw into a failed tool result, so the unsafe origin surfaces there as
  // a loud `ok: false` carrying the misconfiguration message rather than as a
  // rejection — either way it is no longer swallowed into a missing link.
  it("surfaces an unsafe configured origin as a failed release authorization result", async () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.example.com"
    mockPrepareRelease.mockResolvedValue({ status: "READY", releaseRunId: "run-1", requestId: "request-1", revisionId: "revision-1" })

    const result = await requestReleaseAuthorization({
      workspaceId: "workspace-1", provider: "GITHUB", repositoryOwner: "rbcodelabs",
      repositoryName: "compass", pullRequestNumber: 42, baseRef: "main",
      headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
      releasePolicyId: "release-policy-v1", taskIds: ["task-1"],
    })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/HTTPS|invalid/i)
  })
})
