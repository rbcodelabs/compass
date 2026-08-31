import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = {
  reviewRevision: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  reviewRequest: { update: vi.fn() },
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
    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" })).resolves.toBe(existing)
    expect(mockPrisma.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "request-1" }, data: expect.objectContaining({ state: "DECIDED" }) }))
  })

  it("rejects reuse of an idempotency key for a different decision identity", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", idempotencyKey: "key-1", actorUserId: "other-user", revisionId: "rev-1", optionId: "option-1", fingerprint: "fp-1", requestId: "request-1" })

    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }))
  })

  it("commits the decision and terminal request state in one transaction", async () => {
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
    const winner = { id: "decision-winner", revisionId: "rev-1" }
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
})
