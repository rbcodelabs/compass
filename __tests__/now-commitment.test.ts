import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  roadmapItem: { findUnique: vi.fn(), update: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  reviewRevision: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}
const mockPrisma = { ...tx, $transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { NowCommitmentError, admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"

const item = { id: "item-1", workspaceId: "ws-1", title: "Ship it", horizon: "NEXT", solutionId: "sol-1", opportunityId: "opp-1", squadId: "squad-1", updatedAt: new Date("2026-08-31T12:00:00Z") }

describe("NOW commitment", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockPrisma.$transaction.mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx))
  })

  it("prepares an immutable revision with explicit approve and reject options", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.reviewRequest.findFirst.mockResolvedValue(null)
    tx.reviewRequest.create.mockResolvedValue({ id: "request-1" })
    tx.reviewRevision.create.mockResolvedValue({ id: "rev-1", fingerprint: "fp-1" })
    tx.reviewRequest.update.mockResolvedValue({})
    const result = await prepareNowCommitment("item-1", { requestedById: "user-1" })
    expect(result).toEqual({ id: "rev-1", fingerprint: "fp-1" })
    expect(tx.reviewRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requiredRole: "ADMIN", options: { create: expect.arrayContaining([expect.objectContaining({ actionKey: "APPROVE_NOW" }), expect.objectContaining({ actionKey: "REJECT_NOW" })]) } }) }))
  })

  it("refuses admission without a matching approved decision", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue(null)
    await expect(admitRoadmapItemToNow("item-1", "decision-missing")).rejects.toBeInstanceOf(NowCommitmentError)
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects a decision owned by another workspace", async () => {
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-other-workspace",
      fingerprint: "fp-current",
      revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-2", subjectId: "item-1", gateType: "NOW_COMMITMENT" } },
      option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" },
    })

    await expect(admitRoadmapItemToNow("item-1", "decision-other-workspace", { fingerprint: () => "fp-current" }))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects a superseded decision even when its fingerprint still matches", async () => {
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-1",
      fingerprint: "fp-current",
      revision: { fingerprint: "fp-current", supersededAt: new Date("2026-08-31T13:00:00Z"), request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } },
      option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" },
    })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { fingerprint: () => "fp-current" }))
      .rejects.toEqual(expect.objectContaining({ code: "STALE_DECISION" }))
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects a non-approving option", async () => {
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-reject",
      fingerprint: "fp-current",
      revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } },
      option: { outcomeClass: "REJECT", continuationKey: "NO_ACTION" },
    })

    await expect(admitRoadmapItemToNow("item-1", "decision-reject", { fingerprint: () => "fp-current" }))
      .rejects.toEqual(expect.objectContaining({ code: "NOT_APPROVED" }))
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("applies an approved matching decision once and returns its receipt", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", fingerprint: "fp-current", revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } }, option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" } })
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })
    await expect(admitRoadmapItemToNow("item-1", "decision-1", { fingerprint: () => "fp-current" })).resolves.toEqual({ id: "receipt-1", status: "APPLIED" })
    expect(tx.roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ horizon: "NOW", nowCommitmentProvenance: "NATIVE_DECISION", nowDecisionRecordId: "decision-1" }) }))
  })

  it("returns an existing receipt without repeating the roadmap mutation", async () => {
    const receipt = { id: "receipt-existing", status: "APPLIED", receiptKey: "now-commitment:item-1:decision-1:v1" }
    tx.decisionApplication.findUnique.mockResolvedValue(receipt)

    await expect(admitRoadmapItemToNow("item-1", "decision-1")).resolves.toBe(receipt)
    expect(tx.roadmapItem.findUnique).not.toHaveBeenCalled()
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
    expect(tx.decisionApplication.create).not.toHaveBeenCalled()
  })

  it("reloads and returns the winning receipt after a concurrent application insert", async () => {
    const winner = { id: "receipt-winner", status: "APPLIED", receiptKey: "now-commitment:item-1:decision-1:v1" }
    tx.decisionApplication.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", fingerprint: "fp-current", revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } }, option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" } })
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockRejectedValue({ code: "P2002" })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { fingerprint: () => "fp-current" })).resolves.toBe(winner)
  })

  it("persists a blocked receipt when application validation fails", async () => {
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue(null)
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-blocked", status: "BLOCKED" })

    await expect(admitRoadmapItemToNow("item-1", "decision-missing")).rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(tx.decisionApplication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "BLOCKED", attemptCount: 1, lastError: expect.stringContaining("matching NOW commitment") }) }))
  })

  it("retries a blocked receipt and marks that same receipt applied", async () => {
    const blocked = { id: "receipt-blocked", status: "BLOCKED", receiptKey: "now-commitment:item-1:decision-1:v1", attemptCount: 1 }
    tx.decisionApplication.findUnique.mockResolvedValue(blocked)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", fingerprint: "fp-current", revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } }, option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" } })
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.update.mockResolvedValue({ ...blocked, status: "APPLIED", attemptCount: 2 })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { fingerprint: () => "fp-current" })).resolves.toEqual(expect.objectContaining({ id: "receipt-blocked", status: "APPLIED" }))
    expect(tx.decisionApplication.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "receipt-blocked" }, data: expect.objectContaining({ status: "APPLIED", attemptCount: { increment: 1 } }) }))
  })
})
