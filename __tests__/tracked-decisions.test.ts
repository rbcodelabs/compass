import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  reviewRequest: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  reviewRevision: { create: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
  opportunity: { findUnique: vi.fn(), update: vi.fn() },
  solution: { findUnique: vi.fn(), update: vi.fn() },
  assumption: { findUnique: vi.fn() },
  roadmapItem: { findUnique: vi.fn(), update: vi.fn() },
  doc: { findUnique: vi.fn() },
  experiment: { findUnique: vi.fn(), update: vi.fn() },
  feedbackItem: { findUnique: vi.fn() },
  evidence: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
  taskLink: { findMany: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import {
  TrackedDecisionError,
  applyTrackedDecision,
  createTrackedDecisionRequest,
  listTrackedDecisions,
  recordDecisionNoAction,
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
    prisma.taskLink.findMany.mockResolvedValue([])
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

  it("snapshots, deduplicates, and canonically orders supporting sources in a v2 packet", async () => {
    const capturedAt = new Date("2026-09-04T12:00:00.000Z")
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Brand test", workspaceId: "ws-1", updatedAt: capturedAt })
    prisma.assumption.findUnique.mockResolvedValue({ id: "assumption-1", title: "People understand the brand", updatedAt: capturedAt, solution: { opportunity: { workspaceId: "ws-1" } } })
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Brand concepts", updatedAt: capturedAt, opportunity: { workspaceId: "ws-1" } })

    await createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready to run?", context: "## Recommendation\nKeep designing.", idempotencyKey: key1,
      sources: [
        { type: "SOLUTION", id: "solution-1" },
        { type: "ASSUMPTION", id: "assumption-1" },
        { type: "SOLUTION", id: "solution-1" },
        { type: "EXPERIMENT", id: "experiment-1" },
      ],
    })

    const packet = JSON.parse(prisma.reviewRevision.create.mock.calls[0][0].data.packetJson)
    expect(packet).toEqual(expect.objectContaining({
      schemaVersion: "tracked-decision/v2",
      entity: expect.objectContaining({ type: "EXPERIMENT", id: "experiment-1", title: "Brand test", updatedAt: capturedAt.toISOString() }),
      sources: [
        { type: "ASSUMPTION", id: "assumption-1", title: "People understand the brand", updatedAt: capturedAt.toISOString() },
        { type: "SOLUTION", id: "solution-1", title: "Brand concepts", updatedAt: capturedAt.toISOString() },
      ],
    }))
  })

  it("rejects an invalid supporting source before creating any request", async () => {
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Brand test", workspaceId: "ws-1", updatedAt: new Date() })
    prisma.doc.findUnique.mockResolvedValue({ id: "doc-1", title: "Private plan", workspaceId: "ws-other", updatedAt: new Date() })

    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready?", context: "Review it.", idempotencyKey: key1,
      sources: [{ type: "DOC", id: "doc-1" }],
    })).rejects.toEqual(expect.objectContaining({ code: "ENTITY_NOT_FOUND" }))
    expect(prisma.reviewRequest.create).not.toHaveBeenCalled()
  })

  it("limits supporting sources to twelve", async () => {
    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready?", context: "Review it.", idempotencyKey: key1,
      sources: Array.from({ length: 13 }, (_, index) => ({ type: "DOC" as const, id: `doc-${index}` })),
    })).rejects.toEqual(expect.objectContaining({ code: "INVALID_INPUT" }))
    expect(prisma.experiment.findUnique).not.toHaveBeenCalled()
  })

  it("treats normalized sources as part of idempotency equality", async () => {
    const updatedAt = new Date("2026-09-04T12:00:00.000Z")
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Brand test", workspaceId: "ws-1", updatedAt })
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Brand concepts", updatedAt, opportunity: { workspaceId: "ws-1" } })
    const packetJson = JSON.stringify({ schemaVersion: "tracked-decision/v2", question: "Ready?", context: "Review it.", entity: { type: "EXPERIMENT", id: "experiment-1", title: "Brand test", updatedAt: updatedAt.toISOString() }, sources: [] })
    prisma.reviewRequest.findFirst.mockResolvedValue({ currentRevision: { packetJson } })

    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready?", context: "Review it.", idempotencyKey: key1,
      sources: [{ type: "SOLUTION", id: "solution-1" }],
    })).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }))
  })

  it("replays after primary and supporting source snapshots change", async () => {
    const originalAt = "2026-09-04T12:00:00.000Z"
    const currentRevision = { id: "revision-current", packetJson: JSON.stringify({
      schemaVersion: "tracked-decision/v2", question: "Ready?", context: "Review it.",
      entity: { type: "EXPERIMENT", id: "experiment-1", title: "Original test", updatedAt: originalAt },
      sources: [{ type: "SOLUTION", id: "solution-1", title: "Original concepts", updatedAt: originalAt }],
    }) }
    prisma.reviewRequest.findFirst.mockResolvedValue({ currentRevision })
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Renamed test", workspaceId: "ws-1", updatedAt: new Date("2026-09-05T12:00:00.000Z") })
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Renamed concepts", updatedAt: new Date("2026-09-05T12:00:00.000Z"), opportunity: { workspaceId: "ws-1" } })

    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready?", context: "Review it.", idempotencyKey: key1,
      sources: [{ type: "SOLUTION", id: "solution-1" }],
    })).resolves.toBe(currentRevision)
  })

  it("replays reordered and duplicated source inputs by canonical identity", async () => {
    const updatedAt = new Date("2026-09-04T12:00:00.000Z")
    const currentRevision = { id: "revision-current", packetJson: JSON.stringify({
      schemaVersion: "tracked-decision/v2", question: "Ready?", context: "Review it.",
      entity: { type: "EXPERIMENT", id: "experiment-1", title: "Test", updatedAt: updatedAt.toISOString() },
      sources: [
        { type: "ASSUMPTION", id: "assumption-1", title: "Assumption", updatedAt: updatedAt.toISOString() },
        { type: "SOLUTION", id: "solution-1", title: "Concepts", updatedAt: updatedAt.toISOString() },
      ],
    }) }
    prisma.reviewRequest.findFirst.mockResolvedValue({ currentRevision })
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Test", workspaceId: "ws-1", updatedAt })
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Concepts", updatedAt, opportunity: { workspaceId: "ws-1" } })
    prisma.assumption.findUnique.mockResolvedValue({ id: "assumption-1", title: "Assumption", updatedAt, solution: { opportunity: { workspaceId: "ws-1" } } })

    await expect(createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1",
      question: "Ready?", context: "Review it.", idempotencyKey: key1,
      sources: [
        { type: "SOLUTION", id: "solution-1" },
        { type: "ASSUMPTION", id: "assumption-1" },
        { type: "SOLUTION", id: "solution-1" },
      ],
    })).resolves.toBe(currentRevision)
  })

  it("preserves v2 supporting sources when revising", async () => {
    const updatedAt = new Date("2026-09-04T12:00:00.000Z")
    const sources = [{ type: "SOLUTION", id: "solution-1", title: "Brand concepts", updatedAt: updatedAt.toISOString() }]
    prisma.experiment.findUnique.mockResolvedValue({ id: "experiment-1", title: "Brand test", workspaceId: "ws-1", updatedAt })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ schemaVersion: "tracked-decision/v2", entity: { type: "EXPERIMENT", id: "experiment-1" }, sources }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old", option: { outcomeClass: "REQUEST_CHANGES" } })

    await reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "EXPERIMENT", subjectId: "experiment-1", question: "Ready now?", context: "Updated.", expectedDecisionId: "decision-1", reason: "Prototype added" })

    const packet = JSON.parse(prisma.reviewRevision.create.mock.calls[0][0].data.packetJson)
    expect(packet.schemaVersion).toBe("tracked-decision/v2")
    expect(packet.sources).toEqual(sources)
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
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old", option: { outcomeClass: "REQUEST_CHANGES" } })

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
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-other", requestId: "request-other" })

    await expect(reviseTrackedDecisionRequest({
      requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context",
      expectedDecisionId: "decision-other", reason: "Changed",
    })).rejects.toBeInstanceOf(TrackedDecisionError)
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("does not reopen the current cycle from an older decision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-current", revisionCount: 2, decisionCycle: 2, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-old", requestId: "request-1", revisionId: "revision-old" })
    await expect(reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New context", expectedDecisionId: "decision-old", reason: "Changed" }))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
  })

  it("rejects switching the linked entity during revision", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-2", title: "Other", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    await expect(reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-2", question: "Again?", context: "New", expectedDecisionId: "decision-1", reason: "Changed" }))
      .rejects.toEqual(expect.objectContaining({ code: "ENTITY_MISMATCH" }))
    expect(prisma.decisionRecord.findUnique).not.toHaveBeenCalled()
  })

  it.each(["APPROVE", "REJECT"])("does not revise after %s", async (outcomeClass) => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old", option: { outcomeClass } })
    await expect(reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "New", expectedDecisionId: "decision-1", reason: "Changed" }))
      .rejects.toEqual(expect.objectContaining({ code: "OUTCOME_NOT_REVISABLE" }))
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
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old", option: { outcomeClass: "REQUEST_CHANGES" } })
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

  it("persists requestedByAgentId alongside requestedById on create", async () => {
    prisma.solution.findUnique.mockResolvedValue({ id: "solution-1", title: "Simple decisions", opportunity: { workspaceId: "ws-1" } })

    await createTrackedDecisionRequest({
      workspaceId: "ws-1", subjectType: "SOLUTION", subjectId: "solution-1",
      question: "Should we build this?", context: "Customers asked for it.",
      requestedById: "user-1", requestedByAgentId: "agent-1", idempotencyKey: key1,
    })

    expect(prisma.reviewRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ requestedById: "user-1", requestedByAgentId: "agent-1" }) })
  })

  it("preserves the existing requestedByAgentId on revise when none is supplied", async () => {
    prisma.feedbackItem.findUnique.mockResolvedValue({ id: "feedback-1", title: "Export", workspaceId: "ws-1" })
    prisma.reviewRequest.findUnique.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-old", revisionCount: 1, decisionCycle: 1, requestedByAgentId: "agent-original", currentRevision: { packetJson: JSON.stringify({ entity: { type: "FEEDBACK", id: "feedback-1" } }) } })
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", revisionId: "revision-old", option: { outcomeClass: "REQUEST_CHANGES" } })

    await reviseTrackedDecisionRequest({ requestId: "request-1", workspaceId: "ws-1", subjectType: "FEEDBACK", subjectId: "feedback-1", question: "Again?", context: "Updated.", expectedDecisionId: "decision-1", reason: "Changed" })

    expect(prisma.reviewRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestedByAgentId: "agent-original" }) }))
  })

  describe("recordDecisionNoAction", () => {
    it("closes a decided decision with no linked work", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", noActionAt: null })
      prisma.taskLink.findMany.mockResolvedValue([])
      prisma.reviewRequest.update.mockResolvedValue({ id: "request-1", noActionAt: new Date(), noActionReason: "Informational only" })

      await recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "Informational only", actorUserId: "user-1" })

      expect(prisma.reviewRequest.update).toHaveBeenCalledWith({
        where: { id: "request-1" },
        data: expect.objectContaining({ noActionById: "user-1", noActionReason: "Informational only", noActionAt: expect.any(Date) }),
      })
    })

    it("rejects a missing decision", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue(null)
      await expect(recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "Why", actorUserId: "user-1" }))
        .rejects.toEqual(expect.objectContaining({ code: "REQUEST_NOT_FOUND" }))
    })

    it("rejects a decision that is not yet DECIDED", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "PENDING", noActionAt: null })
      await expect(recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "Why", actorUserId: "user-1" }))
        .rejects.toEqual(expect.objectContaining({ code: "NOT_DECIDED" }))
      expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
    })

    it("rejects a decision already closed as no action needed", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", noActionAt: new Date() })
      await expect(recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "Why", actorUserId: "user-1" }))
        .rejects.toEqual(expect.objectContaining({ code: "ALREADY_CLOSED" }))
      expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
    })

    it("refuses to close a decision that already has linked follow-up work", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", noActionAt: null })
      prisma.taskLink.findMany.mockResolvedValue([{ linkedId: "request-1" }])
      await expect(recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "Why", actorUserId: "user-1" }))
        .rejects.toEqual(expect.objectContaining({ code: "HAS_LINKED_WORK" }))
      expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
    })

    it("requires a non-empty reason", async () => {
      prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", noActionAt: null })
      await expect(recordDecisionNoAction({ workspaceId: "ws-1", requestId: "request-1", reason: "  ", actorUserId: "user-1" }))
        .rejects.toThrow()
      expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
    })
  })

  describe("AWAITING_FOLLOW_THROUGH tab", () => {
    it("excludes decided decisions that already have linked follow-up work", async () => {
      prisma.reviewRequest.findMany.mockResolvedValue([
        { id: "request-linked", updatedAt: new Date() },
        { id: "request-unlinked", updatedAt: new Date() },
      ])
      prisma.taskLink.findMany.mockResolvedValue([{ linkedId: "request-linked" }])

      const result = await listTrackedDecisions({ workspaceId: "ws-1", tab: "AWAITING_FOLLOW_THROUGH" })

      expect(prisma.reviewRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED", noActionAt: null }),
      }))
      expect(result.requests.map((request) => request.id)).toEqual(["request-unlinked"])
      expect(result.total).toBe(1)
    })

    it("returns an empty page without querying task links when there are no DECIDED candidates", async () => {
      prisma.reviewRequest.findMany.mockResolvedValue([])

      const result = await listTrackedDecisions({ workspaceId: "ws-1", tab: "AWAITING_FOLLOW_THROUGH" })

      expect(prisma.taskLink.findMany).not.toHaveBeenCalled()
      expect(result.requests).toEqual([])
      expect(result.total).toBe(0)
    })

    it("paginates after filtering out linked/closed decisions", async () => {
      prisma.reviewRequest.findMany.mockResolvedValue(
        Array.from({ length: 3 }, (_, index) => ({ id: `request-${index}`, updatedAt: new Date() })),
      )
      prisma.taskLink.findMany.mockResolvedValue([])

      const result = await listTrackedDecisions({ workspaceId: "ws-1", tab: "AWAITING_FOLLOW_THROUGH", page: 2, pageSize: 2 })

      expect(result.requests.map((request) => request.id)).toEqual(["request-2"])
      expect(result.total).toBe(3)
      expect(result.pageCount).toBe(2)
    })
  })
})

// applyTrackedDecision is the applicator for the ordinary workspace Decisions
// queue (gateType TRACKED_DECISION). Every option on a tracked decision has
// continuationKey NO_ACTION (this is a tracking-only provider — see the
// `options` array above), so applying one must never touch product state; it
// only ever records a durable DecisionApplication receipt.
describe("applyTrackedDecision", () => {
  const decidedTrackedDecision = {
    id: "decision-1",
    requestId: "request-1",
    revisionId: "revision-1",
    optionId: "option-1",
    fingerprint: "fp-1",
    revision: {
      id: "revision-1",
      supersededAt: null,
      fingerprint: "fp-1",
      options: [{ id: "option-1" }],
      request: { id: "request-1", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevisionId: "revision-1" },
    },
    option: { id: "option-1", continuationKey: "NO_ACTION" },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
    prisma.decisionRecord.findUnique.mockResolvedValue(decidedTrackedDecision)
  })

  it("applies a decided tracked decision and returns a durable NO_ACTION receipt", async () => {
    const receipt = { id: "application-1", decisionId: "decision-1", continuationKey: "NO_ACTION", targetType: "TRACKED_DECISION", targetId: "request-1", status: "APPLIED", receiptKey: "tracked-decision:decision-1:v1" }
    prisma.decisionApplication.create.mockResolvedValue(receipt)

    await expect(applyTrackedDecision("decision-1")).resolves.toEqual(receipt)

    expect(prisma.decisionApplication.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      decisionId: "decision-1", continuationKey: "NO_ACTION", targetType: "TRACKED_DECISION", targetId: "request-1", status: "APPLIED", receiptKey: "tracked-decision:decision-1:v1",
    }) })
  })

  it("triggers no product mutation as a side effect of applying", async () => {
    prisma.decisionApplication.create.mockResolvedValue({ id: "application-1", status: "APPLIED" })

    await applyTrackedDecision("decision-1")

    for (const model of [prisma.opportunity, prisma.solution, prisma.roadmapItem, prisma.experiment, prisma.feedbackItem, prisma.assumption]) {
      if ("update" in model) expect(model.update).not.toHaveBeenCalled()
      if ("create" in model) expect(model.create).not.toHaveBeenCalled()
    }
    // The only write this ever performs is the receipt itself.
    expect(prisma.decisionApplication.create).toHaveBeenCalledOnce()
  })

  it("is idempotent: a repeat apply replays the existing receipt without re-deriving or re-creating it", async () => {
    const existing = { id: "application-1", decisionId: "decision-1", continuationKey: "NO_ACTION", targetType: "TRACKED_DECISION", targetId: "request-1", status: "APPLIED", receiptKey: "tracked-decision:decision-1:v1" }
    prisma.decisionApplication.findUnique.mockResolvedValue(existing)

    await expect(applyTrackedDecision("decision-1")).resolves.toBe(existing)

    expect(prisma.decisionRecord.findUnique).not.toHaveBeenCalled()
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })

  it("returns the winning receipt when two applications race", async () => {
    const winner = { id: "application-1", decisionId: "decision-1", continuationKey: "NO_ACTION", targetType: "TRACKED_DECISION", targetId: "request-1", status: "APPLIED", receiptKey: "tracked-decision:decision-1:v1" }
    prisma.decisionApplication.create.mockRejectedValue({ code: "P2002" })
    prisma.decisionApplication.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)

    await expect(applyTrackedDecision("decision-1")).resolves.toBe(winner)
  })

  it("rejects a decision that has not reached a terminal DECIDED state", async () => {
    prisma.decisionRecord.findUnique.mockResolvedValue({
      ...decidedTrackedDecision,
      revision: { ...decidedTrackedDecision.revision, request: { ...decidedTrackedDecision.revision.request, state: "PENDING" } },
    })
    await expect(applyTrackedDecision("decision-1")).rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })

  it("rejects a decision from a different gate type", async () => {
    prisma.decisionRecord.findUnique.mockResolvedValue({
      ...decidedTrackedDecision,
      revision: { ...decidedTrackedDecision.revision, request: { ...decidedTrackedDecision.revision.request, gateType: "BUILDING_INVESTMENT" } },
    })
    await expect(applyTrackedDecision("decision-1")).rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })
})
