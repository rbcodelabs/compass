import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  reviewRequest: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
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
  reviseTrackedDecisionRequest,
} from "@/lib/tracked-decisions"

const key1 = "00000000-0000-4000-8000-000000000001"
const key2 = "00000000-0000-4000-8000-000000000002"

describe("tracked decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    prisma.reviewRequest.create.mockResolvedValue({ id: "request-1", decisionCycle: 1, revisionCount: 0 })
    prisma.reviewRevision.create.mockResolvedValue({ id: "revision-1", requestId: "request-1", fingerprint: "fp" })
    prisma.reviewRequest.update.mockResolvedValue({})
    prisma.reviewRequest.updateMany.mockResolvedValue({ count: 1 })
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
      idempotencyKey: key1,
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
    expect(prisma.reviewRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ subjectType: "TRACKED_DECISION", subjectId: key1 }) })
    expect(prisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "PENDING", currentRevisionId: "revision-1" }) }))
  })

  it("rejects cross-workspace entity references before creating a request", async () => {
    prisma.doc.findUnique.mockResolvedValue({ id: "doc-1", title: "Plan", workspaceId: "ws-other" })

    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "DOC", subjectId: "doc-1", question: "Publish?", context: "Review it.", idempotencyKey: key1 }))
      .rejects.toEqual(expect.objectContaining({ code: "ENTITY_NOT_FOUND" }))
    expect(prisma.reviewRequest.create).not.toHaveBeenCalled()
  })

  it("returns the current revision when the same pending request is retried", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })
    const currentRevision = { id: "revision-current", requestId: "request-1", packetJson: JSON.stringify({ question: "Build it?", context: "Same context", entity: { type: "SOLUTION", id: "solution-1", title: "Simple decisions" } }) }
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "PENDING", currentRevisionId: "revision-current", currentRevision, revisionCount: 1, decisionCycle: 1 })

    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1", question: "Build it?", context: "Same context", idempotencyKey: key1 }))
      .resolves.toBe(currentRevision)
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("reopens a decided request as a new immutable cycle linked to the terminal decision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old" })

    await reviseTrackedDecisionRequest({
      requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1",
      question: "Reconsider export?", context: "Updated customer evidence.", requestedById: "user-1",
      expectedDecisionId: "decision-1", reason: "The evidence changed.",
    })

    expect(prisma.reviewRevision.update).toHaveBeenCalledWith({ where: { id: "revision-old" }, data: { supersededAt: expect.any(Date) } })
    expect(prisma.reviewRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      decisionCycle: 2, reconsidersDecisionId: "decision-1", reopenReason: "The evidence changed.", state: "PENDING",
    }) }))
  })

  it("requires exact historical decision identity to revise", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-other", requestId: "request-other" })

    await expect(reviseTrackedDecisionRequest({
      requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context",
      expectedDecisionId: "decision-other", reason: "Changed",
    })).rejects.toBeInstanceOf(TrackedDecisionError)
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("does not reopen the current cycle from an older decision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-current", revisionCount: 2, decisionCycle: 2 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-old", requestId: "request-1", revisionId: "revision-old" })
    await expect(reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context", expectedDecisionId: "decision-old", reason: "Changed" }))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
  })

  it("allows many independent decisions to link to the same entity", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })
    await createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1", question: "First question?", context: "First context", idempotencyKey: key1 })
    await createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1", question: "Second question?", context: "Second context", idempotencyKey: key2 })
    expect(prisma.reviewRequest.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ subjectId: key1 }) })
    expect(prisma.reviewRequest.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ subjectId: key2 }) })
  })

  it("returns the committed request when concurrent identical creates race", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" })
    const currentRevision = { id: "revision-winner", requestId: "request-winner", packetJson: JSON.stringify({ question: "Build it?", context: "Same context", entity: { type: "SOLUTION", id: "solution-1", title: "Simple decisions" } }) }
    prisma.reviewRequest.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "request-winner", state: "PENDING", currentRevision })
    await expect(createTrackedDecisionRequest({ workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1", question: "Build it?", context: "Same context", idempotencyKey: key1 })).resolves.toBe(currentRevision)
  })

  it("reports a domain conflict instead of leaking a concurrent revision constraint error", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1 })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old" })
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" })
    await expect(reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New", expectedDecisionId: "decision-1", reason: "Changed" }))
      .rejects.toEqual(expect.objectContaining({ code: "REVISION_CONFLICT" }))
  })

  it("builds bounded newest-first history filters", async () => {
    prisma.reviewRequest.findMany.mockResolvedValue([])
    prisma.reviewRequest.count.mockResolvedValue(0)

    await listTrackedDecisions({ workspaceId: "ws-1", tab: "DECIDED", subjectType: "DOC", outcome: "REJECT", reviewerId: key2, query: "launch", from: new Date("2026-09-01"), to: new Date("2026-09-03"), page: 2, pageSize: 25 })

    expect(prisma.reviewRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", state: "DECIDED", gateType: "TRACKED_DECISION", currentRevision: expect.any(Object) }),
      orderBy: { updatedAt: "desc" }, skip: 25, take: 25,
    }))
    const call = prisma.reviewRequest.findMany.mock.calls[0][0]
    expect(call.where.decisions).toBeUndefined()
    expect(JSON.stringify(call.where.currentRevision)).toContain("decisions")
  })
})
