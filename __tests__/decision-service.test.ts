import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = {
  reviewRevision: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  reviewRequest: { update: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  organizationMember: { findFirst: vi.fn() },
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
  beforeEach(() => vi.clearAllMocks())

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

  it("returns the original decision for a repeated idempotency key", async () => {
    const existing = { id: "decision-1", idempotencyKey: "key-1" }
    mockPrisma.decisionRecord.findUnique.mockResolvedValue(existing)
    await expect(recordDecision({ actor: { kind: "USER", userId: "user-1" }, revisionId: "rev-1", fingerprint: "fp-1", optionId: "option-1", idempotencyKey: "key-1" })).resolves.toBe(existing)
    expect(mockPrisma.reviewRevision.findUnique).not.toHaveBeenCalled()
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
})
