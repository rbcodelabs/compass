import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  roadmapItem: { findUnique: vi.fn(), update: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  reviewRevision: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
}
const mockPrisma = { ...tx, $transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { NowCommitmentError, admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"

const item = { id: "item-1", workspaceId: "ws-1", title: "Ship it", horizon: "NEXT", solutionId: "sol-1", opportunityId: "opp-1", squadId: "squad-1", updatedAt: new Date("2026-08-31T12:00:00Z") }

describe("NOW commitment", () => {
  beforeEach(() => vi.clearAllMocks())

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

  it("applies an approved matching decision once and returns its receipt", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", fingerprint: "fp-current", revision: { fingerprint: "fp-current", supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } }, option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" } })
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })
    await expect(admitRoadmapItemToNow("item-1", "decision-1", { fingerprint: () => "fp-current" })).resolves.toEqual({ id: "receipt-1", status: "APPLIED" })
    expect(tx.roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ horizon: "NOW", nowCommitmentProvenance: "NATIVE_DECISION", nowDecisionRecordId: "decision-1" }) }))
  })
})
