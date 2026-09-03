import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  reviewRequest: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  reviewRevision: { create: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  opportunity: { findUnique: vi.fn() },
  solution: { findUnique: vi.fn() },
  roadmapItem: { findUnique: vi.fn() },
  doc: { findUnique: vi.fn() },
  experiment: { findUnique: vi.fn() },
  feedbackItem: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import {
  TrackedDecisionError,
  createTrackedDecisionRequest,
  listTrackedDecisions,
} from "@/lib/tracked-decisions"

describe("tracked decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    prisma.reviewRequest.create.mockResolvedValue({ id: "request-1", decisionCycle: 1, revisionCount: 0 })
    prisma.reviewRevision.create.mockResolvedValue({ id: "revision-1", requestId: "request-1", fingerprint: "fp" })
    prisma.reviewRequest.update.mockResolvedValue({})
  })

  it("creates a pending tracking-only request for a workspace-scoped entity", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })

    await createTrackedDecisionRequest({
      workspaceId: "ws-1",
      subjectType: "SOLUTION",
      subjectId: "solution-1",
      question: "Should we build this?",
      context: "Customers asked for a simpler flow.",
      requestedById: "user-1",
    })

    expect(prisma.reviewRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      title: "Should we build this?",
      requiredRole: "ADMIN",
      options: { create: [
        expect.objectContaining({ label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION" }),
        expect.objectContaining({ label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION" }),
        expect.objectContaining({ label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION" }),
      ] },
    }) })
    expect(prisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "PENDING", currentRevisionId: "revision-1" }) }))
  })

  it("rejects cross-workspace entity references before creating a request", async () => {
    prisma.doc.findUnique.mockResolvedValue({ id: "doc-1", title: "Plan", workspaceId: "ws-other" })

    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "DOC", subjectId: "doc-1", question: "Publish?", context: "Review it." }))
      .rejects.toEqual(expect.objectContaining({ code: "ENTITY_NOT_FOUND" }))
    expect(prisma.reviewRequest.create).not.toHaveBeenCalled()
  })

  it("returns the current revision when the same pending request is retried", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })
    const currentRevision = { id: "revision-current", requestId: "request-1", packetJson: JSON.stringify({ question: "Build it?", context: "Same context", entity: { type: "SOLUTION", id: "solution-1", title: "Simple decisions" } }) }
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "PENDING", currentRevisionId: "revision-current", currentRevision, revisionCount: 1, decisionCycle: 1 })

    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1", question: "Build it?", context: "Same context" }))
      .resolves.toBe(currentRevision)
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("reopens a decided request as a new immutable cycle linked to the terminal decision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old" })

    await createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1",
      question: "Reconsider export?", context: "Updated customer evidence.", requestedById: "user-1",
      revise: { expectedDecisionId: "decision-1", reason: "The evidence changed." },
    })

    expect(prisma.reviewRevision.update).toHaveBeenCalledWith({ where: { id: "revision-old" }, data: { supersededAt: expect.any(Date) } })
    expect(prisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      decisionCycle: 2, reconsidersDecisionId: "decision-1", reopenReason: "The evidence changed.", state: "PENDING",
    }) }))
  })

  it("requires exact historical decision identity to revise", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-other", requestId: "request-other" })

    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context",
      revise: { expectedDecisionId: "decision-other", reason: "Changed" },
    })).rejects.toBeInstanceOf(TrackedDecisionError)
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("does not reopen the current cycle from an older decision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "DECIDED", currentRevisionId: "revision-current", revisionCount: 2, decisionCycle: 2 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-old", requestId: "request-1", revisionId: "revision-old" })
    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context", revise: { expectedDecisionId: "decision-old", reason: "Changed" } }))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
  })

  it("builds bounded newest-first history filters", async () => {
    prisma.reviewRequest.findMany.mockResolvedValue([])
    prisma.reviewRequest.count.mockResolvedValue(0)

    await listTrackedDecisions({ workspaceId: "ws-1", tab: "DECIDED", subjectType: "DOC", outcome: "REJECT", reviewerId: "user-2", query: "launch", from: new Date("2026-09-01"), to: new Date("2026-09-03"), page: 2, pageSize: 25 })

    expect(prisma.reviewRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", state: "DECIDED", subjectType: "DOC" }),
      orderBy: { updatedAt: "desc" }, skip: 25, take: 25,
    }))
  })
})
