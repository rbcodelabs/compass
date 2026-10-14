import { beforeEach, describe, expect, it, vi } from "vitest"
const updates = vi.hoisted(() => ({ enabled: false, record: vi.fn() }))
vi.mock("@/lib/workspace-updates-capture", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/workspace-updates-capture")>(), workspaceUpdatesAvailable: async () => updates.enabled, recordWorkspaceUpdate: updates.record }))

const mockPrisma = {
  reviewRevision: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  reviewRequest: { findUnique: vi.fn(), update: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  organizationMember: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { DecisionError, recordDecision } from "@/lib/decision-service"

const revision = {
  id: "rev-1",
  requestId: "request-1",
  fingerprint: "fp-1",
  requiredRole: "ADMIN",
  expiresAt: null,
  supersededAt: null,
  request: { workspaceId: "ws-1", state: "PENDING" },
  options: [{ id: "option-1", outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" }],
}

describe("recordDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updates.enabled = false
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
  })

  it("rejects a service actor before writing a human decision", async () => {
    await expect(recordDecision({ actor: { kind: "SERVICE" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "HUMAN_ACTOR_REQUIRED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("rejects a stale fingerprint", async () => {
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "stale", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "STALE_FINGERPRINT" }))
  })

  it("rejects a superseded revision", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue({ ...revision, supersededAt: new Date("2026-08-31T13:00:00Z") })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "REVISION_NOT_PENDING" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("rejects an expired revision", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue({ ...revision, expiresAt: new Date("2000-01-01T00:00:00Z") })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "REVISION_EXPIRED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("rejects a user with no access to the revision workspace", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null)
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)

    await expect(recordDecision({ actor: { kind: "USER", userId: "outsider" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "ACCESS_DENIED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("rejects a workspace member when the revision requires an admin", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "MEMBER" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)

    await expect(recordDecision({ actor: { kind: "USER", userId: "member-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "ADMIN_REQUIRED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("returns the original decision for a repeated idempotency key", async () => {
    const existing = { id: "decision-1", idempotencyKey: "key-1", actorUserId: "user-1", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1", requestId: "request-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(existing)
    mockPrisma.reviewRequest.findUnique.mockResolvedValue({ currentRevisionId: "rev-1", state: "PENDING" })
    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" })).resolves.toBe(existing)
    expect(mockPrisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "request-1" }, data: expect.objectContaining({ state: "DECIDED" }) }))
  })

  it("does not repair an old idempotent decision over a newer decision cycle", async () => {
    const existing = { id: "decision-old", idempotencyKey: "key-old", actorUserId: "user-1", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1", requestId: "request-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(existing)
    mockPrisma.reviewRequest.findUnique.mockResolvedValue({ currentRevisionId: "rev-2", state: "PENDING" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-old" })).resolves.toBe(existing)

    expect(mockPrisma.reviewRequest.update).not.toHaveBeenCalled()
  })

  it("rejects reuse of an idempotency key for a different decision identity", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", idempotencyKey: "key-1", actorUserId: "other-user", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1", requestId: "request-1" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }))
  })

  it("commits the decision and terminal request state in one transaction", async () => {
    updates.enabled = true
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.create.mockResolvedValue({ id: "decision-atomic" })

    await recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-atomic" })

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce()
    expect(mockPrisma.decisionRecord.create).toHaveBeenCalledOnce()
    expect(mockPrisma.reviewRequest.update).toHaveBeenCalledOnce()
    expect(updates.record).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ entityType: "DECISION", entityId: "request-1", kind: "DECISION_RECORDED", actorType: "USER", actorId: "user-1" }))
  })

  it("records an authorized admin decision with a role snapshot", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.create.mockResolvedValue({ id: "decision-1" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", rationale: "Commit capacity", idempotencyKey: "key-1" })).resolves.toEqual({ id: "decision-1" })
    expect(mockPrisma.decisionRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorUserId: "user-1", actorRole: "ADMIN", fingerprint: "fp-1" }) }))
  })

  it("requires rationale for tracked rejections and change requests", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue({
      ...revision,
      request: { ...revision.request, gateType: "TRACKED_DECISION" },
      options: [{ id: "option-1", outcomeClass: "REJECT", continuationKey: "NO_ACTION" }],
    })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", rationale: " ", idempotencyKey: "key-rationale" }))
      .rejects.toEqual(expect.objectContaining({ code: "RATIONALE_REQUIRED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  describe("tracked decisions with custom options", () => {
    const trackedRevision = {
      ...revision,
      request: { ...revision.request, gateType: "TRACKED_DECISION" },
      options: [
        { id: "choice-1", actionKey: "CHOICE_1", label: "Ship now", description: "Release this week.", outcomeClass: "APPROVE", continuationKey: "NO_ACTION" },
        { id: "choice-2", actionKey: "CHOICE_2", label: "Wait", description: null, outcomeClass: "APPROVE", continuationKey: "NO_ACTION" },
        { id: "changes", actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION" },
        { id: "reject", actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION" },
      ],
    }
    const decide = (optionId: string, rationale?: string) => recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId, rationale, idempotencyKey: `key-${optionId}` })

    beforeEach(() => {
      mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
      mockPrisma.reviewRevision.findUnique.mockResolvedValue(trackedRevision)
      mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
      mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
      mockPrisma.decisionRecord.findFirst.mockResolvedValue(null)
      mockPrisma.decisionRecord.create.mockResolvedValue({ id: "decision-choice" })
    })

    it("records a chosen custom option without a rationale", async () => {
      await expect(decide("choice-1")).resolves.toEqual({ id: "decision-choice" })
      expect(mockPrisma.decisionRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ optionId: "choice-1", rationale: null }) })
      expect(mockPrisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "DECIDED" }) }))
    })

    it("stores an optional rationale alongside a chosen option", async () => {
      await decide("choice-2", "  Capacity is tight.  ")
      expect(mockPrisma.decisionRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ optionId: "choice-2", rationale: "Capacity is tight." }) })
    })

    it.each(["changes", "reject"])("still requires a rationale for %s", async (optionId) => {
      await expect(decide(optionId, "  ")).rejects.toEqual(expect.objectContaining({ code: "RATIONALE_REQUIRED" }))
      expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
      await expect(decide(optionId, "Not viable.")).resolves.toEqual({ id: "decision-choice" })
    })

    it("rejects an option that belongs to another revision", async () => {
      await expect(decide("choice-from-elsewhere")).rejects.toEqual(expect.objectContaining({ code: "OPTION_MISMATCH" }))
      expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
    })
  })

  it("rejects a competing terminal response", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst.mockResolvedValue({ id: "decision-existing" })
    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-2" }))
      .rejects.toBeInstanceOf(DecisionError)
  })

  it("returns the winning decision when two terminal inserts race", async () => {
    const winner = { id: "decision-winner", actorUserId: "user-1", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner)
    mockPrisma.decisionRecord.create.mockRejectedValue({ code: "P2002" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-racer" }))
      .resolves.toBe(winner)
  })

  it("rejects a concurrent terminal winner with a different option identity", async () => {
    const winner = { id: "decision-winner", actorUserId: "user-1", revisionId: "rev-1", optionId: "option-2", fingerprint: "fp-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner)
    mockPrisma.decisionRecord.create.mockRejectedValue({ code: "P2002" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-racer" }))
      .rejects.toEqual(expect.objectContaining({ code: "ALREADY_DECIDED" }))
  })

  it("rejects a concurrent terminal winner recorded by another actor", async () => {
    const winner = { id: "decision-winner", actorUserId: "user-2", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(revision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner)
    mockPrisma.decisionRecord.create.mockRejectedValue({ code: "P2002" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-racer" }))
      .rejects.toEqual(expect.objectContaining({ code: "ALREADY_DECIDED" }))
  })
})

describe("recordDecision with per-question answers", () => {
  const questions = [
    { header: "Timing", question: "When do we ship?", options: [{ label: "Now" }, { label: "Later" }] },
    { question: "Who announces it?", options: [{ label: "PM" }, { label: "Marketing" }] },
  ]
  const multiRevision = {
    ...revision,
    request: { ...revision.request, gateType: "TRACKED_DECISION" },
    packetJson: JSON.stringify({ schemaVersion: "tracked-decision/v2", question: "Plan", context: "c", entity: { type: "SOLUTION", id: "s" }, sources: [], questions }),
    options: [
      { id: "submit", actionKey: "SUBMIT_ANSWERS", label: "Submit answers", outcomeClass: "APPROVE", continuationKey: "NO_ACTION" },
      { id: "changes", actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION" },
      { id: "reject", actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION" },
    ],
  }
  const decide = (optionId: string, extra: { rationale?: string; answers?: Array<{ questionIndex: number; chosenOption: string }> } = {}) =>
    recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId, idempotencyKey: `key-${optionId}`, ...extra })
  const goodAnswers = [{ questionIndex: 1, chosenOption: "Marketing" }, { questionIndex: 0, chosenOption: "Now" }]

  beforeEach(() => {
    vi.clearAllMocks()
    updates.enabled = false
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(null)
    mockPrisma.reviewRevision.findUnique.mockResolvedValue(multiRevision)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.findFirst.mockResolvedValue(null)
    mockPrisma.decisionRecord.create.mockResolvedValue({ id: "decision-multi" })
  })

  it("records an APPROVE with every answer, ordered by question, snapshotting the question text", async () => {
    await expect(decide("submit", { answers: goodAnswers })).resolves.toEqual({ id: "decision-multi" })
    const data = mockPrisma.decisionRecord.create.mock.calls[0][0].data
    expect(data.optionId).toBe("submit")
    expect(data.rationale).toBeNull()
    expect(JSON.parse(data.answersJson)).toEqual([
      { questionIndex: 0, question: "When do we ship?", chosenOption: "Now" },
      { questionIndex: 1, question: "Who announces it?", chosenOption: "Marketing" },
    ])
  })

  it("rejects a submission that misses a question", async () => {
    await expect(decide("submit", { answers: [{ questionIndex: 0, chosenOption: "Now" }] })).rejects.toEqual(expect.objectContaining({ code: "ANSWERS_INCOMPLETE" }))
    await expect(decide("submit")).rejects.toEqual(expect.objectContaining({ code: "ANSWERS_INCOMPLETE" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it.each([
    ["an unknown option label", [{ questionIndex: 0, chosenOption: "Never" }, { questionIndex: 1, chosenOption: "PM" }]],
    ["another question's option", [{ questionIndex: 0, chosenOption: "PM" }, { questionIndex: 1, chosenOption: "PM" }]],
    ["an out-of-range question", [...goodAnswers, { questionIndex: 2, chosenOption: "PM" }]],
    ["a repeated question", [...goodAnswers, { questionIndex: 0, chosenOption: "Later" }]],
  ])("rejects %s", async (_name, answers) => {
    await expect(decide("submit", { answers })).rejects.toEqual(expect.objectContaining({ code: "ANSWER_INVALID" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it.each(["changes", "reject"])("lets %s apply to the whole request with a rationale and no answers", async (optionId) => {
    await expect(decide(optionId, { rationale: "Not now." })).resolves.toEqual({ id: "decision-multi" })
    expect(mockPrisma.decisionRecord.create.mock.calls[0][0].data).not.toHaveProperty("answersJson")
  })

  it.each(["changes", "reject"])("still requires a rationale for %s", async (optionId) => {
    await expect(decide(optionId, { rationale: " " })).rejects.toEqual(expect.objectContaining({ code: "RATIONALE_REQUIRED" }))
  })

  it("refuses answers attached to Request changes or Reject", async () => {
    await expect(decide("changes", { rationale: "No.", answers: goodAnswers })).rejects.toEqual(expect.objectContaining({ code: "ANSWERS_NOT_ALLOWED" }))
    expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
  })

  it("does not write answersJson for a decision without questions", async () => {
    mockPrisma.reviewRevision.findUnique.mockResolvedValue({ ...revision, request: { ...revision.request, gateType: "TRACKED_DECISION" }, packetJson: "{}" })
    await decide("option-1")
    expect(mockPrisma.decisionRecord.create.mock.calls[0][0].data).not.toHaveProperty("answersJson")
  })

  describe("idempotent replay", () => {
    const record = (answers: unknown) => ({ id: "decision-multi", actorUserId: "user-1", revisionId: "rev-1", optionId: "submit", fingerprint: "fp-1", requestId: "request-1", answersJson: answers ? JSON.stringify(answers) : null })
    const stored = [{ questionIndex: 0, question: "When do we ship?", chosenOption: "Now" }, { questionIndex: 1, question: "Who announces it?", chosenOption: "Marketing" }]

    beforeEach(() => {
      mockPrisma.reviewRequest.findUnique.mockResolvedValue({ currentRevisionId: "rev-1", state: "DECIDED" })
    })

    it("replays the stored decision when the same answers are resubmitted, in any order", async () => {
      mockPrisma.decisionRecord.findUnique.mockResolvedValue(record(stored))
      await expect(decide("submit", { answers: goodAnswers })).resolves.toEqual(expect.objectContaining({ id: "decision-multi" }))
      expect(mockPrisma.decisionRecord.create).not.toHaveBeenCalled()
    })

    it("conflicts when the same key is reused with different answers", async () => {
      mockPrisma.decisionRecord.findUnique.mockResolvedValue(record(stored))
      await expect(decide("submit", { answers: [{ questionIndex: 0, chosenOption: "Later" }, { questionIndex: 1, chosenOption: "Marketing" }] })).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }))
    })

    it("still replays an answer-less decision recorded before answers existed", async () => {
      mockPrisma.decisionRecord.findUnique.mockResolvedValue({ ...record(null), optionId: "changes" })
      await expect(decide("changes", { rationale: "x" })).resolves.toEqual(expect.objectContaining({ id: "decision-multi" }))
    })
  })
})
