import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  prisma: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  recordDecision: vi.fn(),
  auth: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => m.prisma }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: m.recordDecision }))
vi.mock("@/lib/release-authorization", () => ({ queueAuthorizedRelease: vi.fn() }))
vi.mock("@/lib/github-release-source-revalidator", () => ({ getReleaseSourceRevalidator: vi.fn() }))

import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { applyRecordedDecision, getReviewRequest, listReviewRequests } from "@/lib/decision-tool-handlers"
import { listTrackedDecisions } from "@/lib/tracked-decisions"

const NOT_TOOL_APPROVAL = { gateType: { not: "TOOL_APPROVAL" } }

beforeEach(() => {
  vi.clearAllMocks()
  m.prisma = {
    reviewRevision: { findUnique: vi.fn() },
    reviewRequest: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    decisionRecord: { findUnique: vi.fn() },
    workspace: { findUnique: vi.fn().mockResolvedValue({ slug: "product", organization: { slug: "acme" } }), findMany: vi.fn().mockResolvedValue([]) },
  }
})

describe("generic review surfaces refuse TOOL_APPROVAL", () => {
  it("decideReviewAction throws, points at the approval page, and never records a decision", async () => {
    m.prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { id: "req-1", workspaceId: "ws-1", gateType: "TOOL_APPROVAL" } })
    m.auth.mockResolvedValue({ user: { id: "admin-1" } })
    await expect(decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "f", optionId: "o" })).rejects.toThrow(/approval page.*\/acme\/product\/approvals\/req-1/s)
    expect(m.recordDecision).not.toHaveBeenCalled()
  })

  it("decideReviewAction still reaches recordDecision for an ordinary tracked decision", async () => {
    m.prisma.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", request: { id: "req-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION" } })
    m.auth.mockResolvedValue({ user: { id: "u1" } })
    m.prisma.workspace.findFirst = vi.fn().mockResolvedValue({ id: "ws-1", members: [{ id: "m" }], organization: { members: [] } })
    m.recordDecision.mockResolvedValue({ id: "d1" })
    await decideReviewAction({ workspaceId: "ws-1", revisionId: "rev-1", fingerprint: "f", optionId: "o" })
    expect(m.recordDecision).toHaveBeenCalledTimes(1)
  })

  it("apply_recorded_decision refuses an approval's decision and applies nothing", async () => {
    m.prisma.decisionRecord.findUnique.mockResolvedValue({ id: "d1", revision: { sourceFingerprint: null, request: { gateType: "TOOL_APPROVAL" } } })
    const result = await applyRecordedDecision({ decisionId: "d1" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/approval page/i)
  })
})

describe("generic readers exclude TOOL_APPROVAL rows", () => {
  it("get_review_request looks the request up with the exclusion, so an approval id is simply not found", async () => {
    const result = await getReviewRequest({ requestId: "req-1" })
    expect(m.prisma.reviewRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "req-1", ...NOT_TOOL_APPROVAL } }))
    expect(result.structuredContent.ok).toBe(false)
  })

  it("list_review_requests filters them out, with and without a state", async () => {
    await listReviewRequests({ workspaceId: "ws-1" })
    await listReviewRequests({ workspaceId: "ws-1", state: "PENDING" })
    expect(m.prisma.reviewRequest.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", ...NOT_TOOL_APPROVAL })
    expect(m.prisma.reviewRequest.findMany.mock.calls[1][0].where).toEqual({ workspaceId: "ws-1", ...NOT_TOOL_APPROVAL, state: "PENDING" })
  })

  it("the decisions list excludes them in legacy-inclusive mode and is TRACKED_DECISION-only otherwise", async () => {
    await listTrackedDecisions({ workspaceId: "ws-1", includeLegacy: true } as never)
    await listTrackedDecisions({ workspaceId: "ws-1" } as never)
    expect(m.prisma.reviewRequest.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1", ...NOT_TOOL_APPROVAL })
    expect(m.prisma.reviewRequest.findMany.mock.calls[1][0].where).toMatchObject({ workspaceId: "ws-1", gateType: "TRACKED_DECISION" })
  })
})
