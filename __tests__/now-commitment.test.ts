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

import { NowCommitmentError, admitRoadmapItemToNow, ensureNowCommitmentRevisionFresh, nowCommitmentFingerprint, prepareNowCommitment, startNewNowCommitmentDecisionCycle } from "@/lib/now-commitment"

const item = { id: "item-1", workspaceId: "ws-1", title: "Ship it", description: "Scope", horizon: "NEXT", status: "ACTIVE", solutionId: "sol-1", opportunityId: "opp-1", squadId: "squad-1", startDate: null, endDate: null, isPrivate: false, sortOrder: 2, updatedAt: new Date("2026-08-31T12:00:00Z"), nowCommitmentProvenance: "LEGACY_UNGATED" }
const eligibility = {
  portfolioPolicyId: "portfolio-policy:v1:test",
  investmentDecision: { authorityProvider: "OBSIDIAN" as const, authorityRecordId: "DEC-1", authorityChecksum: "a".repeat(64), subjectId: "sol-1", decisionOutcome: "APPROVE_BUILDING" as const, applicationStatus: "APPLIED" as const, applicationReceiptId: "receipt-1" },
  capacity: { planId: "plan-1", planFingerprint: "b".repeat(64), unit: "CONFIGURED_UNIT", availableUnits: 3, requestedUnits: 1, reservedUnits: 1, reservedRoadmapItemIds: ["now-1"], nowLimit: 3 },
}

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
    const result = await prepareNowCommitment("item-1", { requestedById: "user-1", eligibility })
    expect(result).toEqual({ id: "rev-1", fingerprint: "fp-1" })
    expect(tx.reviewRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requiredRole: "ADMIN", options: { create: expect.arrayContaining([expect.objectContaining({ actionKey: "APPROVE_NOW" }), expect.objectContaining({ actionKey: "REJECT_NOW" })]) } }) }))
  })

  it("fails closed when explicit NOW policy inputs are not configured", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)

    await expect(prepareNowCommitment("item-1", { requestedById: "user-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
    expect(tx.reviewRequest.create).not.toHaveBeenCalled()
  })

  it("fingerprints current horizon and every material roadmap field", () => {
    const baseline = nowCommitmentFingerprint(item)
    for (const changed of [
      { title: "Changed" }, { description: "Changed" }, { horizon: "LATER" }, { status: "ARCHIVED" },
      { solutionId: "sol-2" }, { opportunityId: "opp-2" }, { squadId: "squad-2" },
      { startDate: new Date("2026-09-01") }, { endDate: new Date("2026-09-30") }, { isPrivate: true }, { sortOrder: 9 },
    ]) {
      expect(nowCommitmentFingerprint({ ...item, ...changed })).not.toBe(baseline)
    }
  })

  it("requires an explicit new decision cycle for a terminal same-source review", async () => {
    const sourceFingerprint = nowCommitmentFingerprint(item, eligibility)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", state: "DECIDED", revisionCount: 1, currentRevisionId: "rev-1", currentRevision: { id: "rev-1", fingerprint: sourceFingerprint } })

    await expect(prepareNowCommitment("item-1", { requestedById: "user-1", eligibility }))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_CYCLE_REQUIRED" }))
    expect(tx.reviewRevision.update).not.toHaveBeenCalled()
    expect(tx.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("starts a new immutable cycle to reconsider a rejected same-source decision", async () => {
    const sourceFingerprint = nowCommitmentFingerprint(item, eligibility)
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.reviewRequest.findFirst.mockResolvedValue({
      id: "request-1", state: "DECIDED", revisionCount: 1, decisionCycle: 1, currentRevisionId: "rev-1",
      currentRevision: { id: "rev-1", sourceFingerprint, fingerprint: "review-fp-1", decisions: [{ id: "decision-reject", option: { outcomeClass: "REJECT" } }] },
    })
    tx.reviewRevision.create.mockResolvedValue({ id: "rev-2", requestId: "request-1", sourceFingerprint, fingerprint: "review-fp-2" })
    tx.reviewRequest.update.mockResolvedValue({})

    await expect(startNewNowCommitmentDecisionCycle("item-1", { reason: "Scope clarified", actorUserId: "user-1", expectedTerminalDecisionId: "decision-reject", eligibility }))
      .resolves.toEqual(expect.objectContaining({ id: "rev-2" }))
    expect(tx.reviewRevision.update).toHaveBeenCalledWith({ where: { id: "rev-1" }, data: { supersededAt: expect.any(Date) } })
    expect(tx.reviewRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ decisionCycle: 2, reconsidersDecisionId: "decision-reject", reopenReason: "Scope clarified", reopenedById: "user-1", state: "PENDING" }) }))
  })

  it("supersedes a pending revision when material item state changes", async () => {
    const reviewedSource = nowCommitmentFingerprint(item, eligibility)
    tx.reviewRevision.findUnique.mockResolvedValue({ id: "rev-1", sourceFingerprint: reviewedSource, supersededAt: null, packetJson: JSON.stringify({ portfolioPolicyId: eligibility.portfolioPolicyId, investmentDecision: eligibility.investmentDecision, capacity: eligibility.capacity, displacement: null }), request: { id: "request-1", currentRevisionId: "rev-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } })
    tx.roadmapItem.findUnique.mockResolvedValue({ ...item, title: "Changed after review", updatedAt: new Date("2026-08-31T13:00:00Z") })
    tx.reviewRevision.update.mockResolvedValue({})
    tx.reviewRequest.update.mockResolvedValue({})

    await expect(ensureNowCommitmentRevisionFresh("rev-1")).resolves.toEqual(expect.objectContaining({ stale: true }))
    expect(tx.reviewRevision.update).toHaveBeenCalledWith({ where: { id: "rev-1" }, data: { supersededAt: expect.any(Date) } })
    expect(tx.reviewRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ state: "SUPERSEDED" }) })
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
