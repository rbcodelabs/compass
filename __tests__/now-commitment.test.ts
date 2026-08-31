import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  roadmapItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  reviewRevision: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { findUnique: vi.fn(), updateMany: vi.fn() },
  portfolioCapacityReservation: { upsert: vi.fn(), update: vi.fn() },
}
const mockPrisma = { ...tx, $transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { NowCommitmentError, admitRoadmapItemToNow, ensureNowCommitmentRevisionFresh, nowCommitmentFingerprint, prepareNowCommitment, startNewNowCommitmentDecisionCycle } from "@/lib/now-commitment"
import { investmentAuthorityChecksum, resolveNowCommitmentEligibility } from "@/lib/now-eligibility"

const item = { id: "item-1", workspaceId: "ws-1", title: "Ship it", description: "Scope", horizon: "NEXT", status: "ACTIVE", solutionId: "sol-1", opportunityId: "opp-1", squadId: "squad-1", startDate: null, endDate: null, isPrivate: false, sortOrder: 2, updatedAt: new Date("2026-08-31T12:00:00Z"), nowCommitmentProvenance: "LEGACY_UNGATED" }
const eligibility = {
  portfolioPolicyId: "portfolio-policy:v1:test",
  investmentDecision: { authorityProvider: "OBSIDIAN" as const, authorityRecordId: "DEC-1", authorityChecksum: "a".repeat(64), subjectId: "sol-1", decisionOutcome: "APPROVE_BUILDING" as const, applicationStatus: "APPLIED" as const, applicationReceiptId: "receipt-1" },
  capacity: { planId: "plan-1", planFingerprint: "b".repeat(64), unit: "CONFIGURED_UNIT", availableUnits: 3, requestedUnits: 1, reservedUnits: 1, reservedRoadmapItemIds: ["now-1"], nowLimit: 3, planVersion: 1 },
}
const configuredIds = {
  item: "00000000-0000-4000-8000-000000000011", workspace: "00000000-0000-4000-8000-000000000012",
  solution: "00000000-0000-4000-8000-000000000013", squad: "00000000-0000-4000-8000-000000000014",
  plan: "00000000-0000-4000-8000-000000000015", reserved: "00000000-0000-4000-8000-000000000016",
  investmentDecision: "00000000-0000-4000-8000-000000000017", investmentRevision: "00000000-0000-4000-8000-000000000018",
  investmentOption: "00000000-0000-4000-8000-000000000019", investmentReceipt: "00000000-0000-4000-8000-00000000001a",
}
const configuredItem = { ...item, id: configuredIds.item, workspaceId: configuredIds.workspace, solutionId: configuredIds.solution, squadId: configuredIds.squad }
const configuredNativeDecision = {
  id: configuredIds.investmentDecision, workspaceId: configuredIds.workspace, revisionId: configuredIds.investmentRevision,
  optionId: configuredIds.investmentOption, fingerprint: "d".repeat(64), decidedAt: new Date("2026-08-31T12:00:00Z"),
  revision: { fingerprint: "d".repeat(64), supersededAt: null, request: { gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: configuredIds.solution, workspaceId: configuredIds.workspace } },
  option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
  applications: [{ id: configuredIds.investmentReceipt, status: "APPLIED", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: configuredIds.solution }],
}
const configuredEligibility = {
  ...eligibility,
  investmentDecision: { ...eligibility.investmentDecision, authorityProvider: "COMPASS_NATIVE" as const, authorityRecordId: configuredIds.investmentDecision, authorityChecksum: investmentAuthorityChecksum(configuredNativeDecision, configuredIds.investmentReceipt), applicationReceiptId: configuredIds.investmentReceipt, subjectId: configuredIds.solution },
  capacity: { ...eligibility.capacity, planId: configuredIds.plan, reservedRoadmapItemIds: [configuredIds.reserved] },
}
function configuredPolicyJson() {
  return JSON.stringify({ version: 1, workspaces: { [configuredIds.workspace]: {
    portfolioPolicyId: configuredEligibility.portfolioPolicyId,
    capacity: { planId: configuredIds.plan, planFingerprint: configuredEligibility.capacity.planFingerprint, unit: configuredEligibility.capacity.unit, availableUnits: 3, requestedUnits: 1, unitsPerNowItem: 1, nowLimit: 3 },
    investmentDecisions: { [configuredIds.solution]: { ...configuredEligibility.investmentDecision, subjectId: undefined } },
  } } })
}
const eligibilityResolver = { resolve: vi.fn(async () => eligibility) }
const reviewedSourceFingerprint = nowCommitmentFingerprint(item, eligibility)
const approvedDecision = (overrides: Record<string, unknown> = {}) => ({
  id: "decision-1",
  fingerprint: "review-fp",
  revision: { fingerprint: "review-fp", sourceFingerprint: reviewedSourceFingerprint, supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } },
  option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" },
  ...overrides,
})

describe("NOW commitment", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockPrisma.$transaction.mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx))
    delete process.env.NOW_COMMITMENT_POLICY_JSON
    tx.portfolioCapacityPlan.findUnique.mockResolvedValue({
      id: eligibility.capacity.planId, workspaceId: item.workspaceId, policyId: eligibility.portfolioPolicyId,
      planFingerprint: eligibility.capacity.planFingerprint, unit: eligibility.capacity.unit,
      availableUnits: eligibility.capacity.availableUnits, nowLimit: eligibility.capacity.nowLimit,
      version: eligibility.capacity.planVersion, state: "ACTIVE",
      reservations: [{ id: "reservation-now-1", roadmapItemId: "now-1", units: 1 }],
    })
    tx.portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 1 })
    tx.portfolioCapacityReservation.upsert.mockResolvedValue({})
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

  it("prepares through the canonical configured resolver without caller-supplied eligibility", async () => {
    process.env.NOW_COMMITMENT_POLICY_JSON = configuredPolicyJson()
    tx.roadmapItem.findUnique.mockResolvedValue(configuredItem)
    tx.decisionRecord.findUnique.mockResolvedValue(configuredNativeDecision)
    tx.portfolioCapacityPlan.findUnique.mockResolvedValue({
      id: configuredIds.plan, workspaceId: configuredIds.workspace, policyId: configuredEligibility.portfolioPolicyId,
      planFingerprint: configuredEligibility.capacity.planFingerprint, unit: configuredEligibility.capacity.unit,
      availableUnits: 3, nowLimit: 3, state: "ACTIVE", version: 1,
      reservations: [{ roadmapItemId: configuredIds.reserved, units: 1 }],
    })
    tx.reviewRequest.findFirst.mockResolvedValue(null)
    tx.reviewRequest.create.mockResolvedValue({ id: "request-1" })
    tx.reviewRevision.create.mockResolvedValue({ id: "rev-1", fingerprint: "fp-1" })

    await expect(prepareNowCommitment("item-1", { requestedById: "user-1" })).resolves.toEqual(expect.objectContaining({ id: "rev-1" }))
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

  it("reloads the identical winner after a concurrent preparation conflict", async () => {
    const sourceFingerprint = nowCommitmentFingerprint(item, eligibility)
    const winner = { id: "rev-winner", sourceFingerprint, fingerprint: "review-winner" }
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.reviewRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "PENDING", currentRevision: winner })
    tx.reviewRequest.create.mockRejectedValue({ code: "P2002" })

    await expect(prepareNowCommitment("item-1", { requestedById: "user-1", eligibility })).resolves.toBe(winner)
  })

  it("rejects a concurrent preparation winner with different material inputs", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.reviewRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "PENDING", currentRevision: { id: "rev-other", sourceFingerprint: "different" } })
    tx.reviewRequest.create.mockRejectedValue({ code: "P2002" })

    await expect(prepareNowCommitment("item-1", { requestedById: "user-1", eligibility }))
      .rejects.toEqual(expect.objectContaining({ code: "PREPARATION_CONFLICT" }))
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

    await expect(ensureNowCommitmentRevisionFresh("rev-1", { eligibilityResolver })).resolves.toEqual(expect.objectContaining({ stale: true }))
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

    await expect(admitRoadmapItemToNow("item-1", "decision-other-workspace", { eligibilityResolver }))
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

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver }))
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

    await expect(admitRoadmapItemToNow("item-1", "decision-reject", { eligibilityResolver }))
      .rejects.toEqual(expect.objectContaining({ code: "NOT_APPROVED" }))
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("applies an approved matching decision once and returns its receipt", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue(approvedDecision())
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })
    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver })).resolves.toEqual({ id: "receipt-1", status: "APPLIED" })
    expect(tx.roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ horizon: "NOW", nowCommitmentProvenance: "NATIVE_DECISION", nowDecisionRecordId: "decision-1" }) }))
  })

  it("uses plan CAS so a concurrent different admission cannot oversubscribe workspace capacity", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue(item)
    tx.decisionRecord.findUnique.mockResolvedValue(approvedDecision())
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 0 })
    tx.decisionApplication.create.mockResolvedValue({ id: "blocked", status: "BLOCKED" })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver }))
      .rejects.toEqual(expect.objectContaining({ code: "CAPACITY_CONFLICT" }))
    expect(tx.portfolioCapacityReservation.upsert).not.toHaveBeenCalled()
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("atomically displaces an active same-workspace reservation before admitting the candidate", async () => {
    const displacementEligibility = {
      ...eligibility,
      capacity: { ...eligibility.capacity, availableUnits: 1, nowLimit: 1 },
      displacement: { itemId: "now-1", destination: "NEXT" as const },
    }
    const displacementResolver = { resolve: vi.fn(async () => displacementEligibility) }
    const displacementSource = nowCommitmentFingerprint(item, displacementEligibility)
    const displaced = { ...item, id: "now-1", horizon: "NOW" }
    tx.roadmapItem.findUnique.mockResolvedValueOnce(item).mockResolvedValueOnce(displaced)
    tx.decisionRecord.findUnique.mockResolvedValue(approvedDecision({
      revision: { fingerprint: "review-fp", sourceFingerprint: displacementSource, supersededAt: null, request: { workspaceId: "ws-1", subjectId: "item-1", gateType: "NOW_COMMITMENT" } },
    }))
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.portfolioCapacityPlan.findUnique.mockResolvedValue({
      id: eligibility.capacity.planId, workspaceId: item.workspaceId, policyId: eligibility.portfolioPolicyId,
      planFingerprint: eligibility.capacity.planFingerprint, unit: eligibility.capacity.unit, availableUnits: 1, nowLimit: 1,
      version: eligibility.capacity.planVersion, state: "ACTIVE",
      reservations: [{ id: "reservation-now-1", roadmapItemId: "now-1", units: 1 }],
    })
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver: displacementResolver })).resolves.toEqual({ id: "receipt-1", status: "APPLIED" })
    expect(tx.roadmapItem.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: "now-1" }, data: expect.objectContaining({ horizon: "NEXT" }) }))
    expect(tx.portfolioCapacityReservation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "reservation-now-1" }, data: expect.objectContaining({ state: "RELEASED" }) }))
    expect(tx.portfolioCapacityReservation.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ roadmapItemId: "item-1", state: "ACTIVE" }) }))
    expect(tx.roadmapItem.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { id: "item-1" }, data: expect.objectContaining({ horizon: "NOW" }) }))
  })

  it("revalidates configured authoritative eligibility during application", async () => {
    process.env.NOW_COMMITMENT_POLICY_JSON = configuredPolicyJson()
    tx.roadmapItem.findUnique.mockResolvedValue(configuredItem)
    tx.portfolioCapacityPlan.findUnique.mockResolvedValue({
      id: configuredIds.plan, workspaceId: configuredIds.workspace, policyId: configuredEligibility.portfolioPolicyId,
      planFingerprint: configuredEligibility.capacity.planFingerprint, unit: configuredEligibility.capacity.unit,
      availableUnits: 3, nowLimit: 3, state: "ACTIVE", version: 1,
      reservations: [{ id: "reservation-configured", roadmapItemId: configuredIds.reserved, units: 1 }],
    })
    tx.decisionRecord.findUnique.mockResolvedValue(configuredNativeDecision)
    const currentEligibility = await resolveNowCommitmentEligibility(configuredItem, mockPrisma as never)
    const approval = {
      id: "decision-1", fingerprint: "review-fp",
      revision: { fingerprint: "review-fp", sourceFingerprint: nowCommitmentFingerprint(configuredItem, currentEligibility), supersededAt: null, request: { workspaceId: configuredIds.workspace, subjectId: configuredIds.item, gateType: "NOW_COMMITMENT" } },
      option: { outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW" },
    }
    tx.decisionRecord.findUnique.mockReset()
    tx.decisionRecord.findUnique.mockResolvedValueOnce(approval).mockResolvedValue(configuredNativeDecision)
    tx.decisionApplication.findUnique.mockResolvedValue(null)
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockResolvedValue({ id: "receipt-real", status: "APPLIED" })

    await expect(admitRoadmapItemToNow(configuredIds.item, "decision-1")).resolves.toEqual({ id: "receipt-real", status: "APPLIED" })
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
    tx.decisionRecord.findUnique.mockResolvedValue(approvedDecision())
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.create.mockRejectedValue({ code: "P2002" })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver })).resolves.toBe(winner)
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
    tx.decisionRecord.findUnique.mockResolvedValue(approvedDecision())
    tx.roadmapItem.update.mockResolvedValue({ ...item, horizon: "NOW" })
    tx.decisionApplication.update.mockResolvedValue({ ...blocked, status: "APPLIED", attemptCount: 2 })

    await expect(admitRoadmapItemToNow("item-1", "decision-1", { eligibilityResolver })).resolves.toEqual(expect.objectContaining({ id: "receipt-blocked", status: "APPLIED" }))
    expect(tx.decisionApplication.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "receipt-blocked" }, data: expect.objectContaining({ status: "APPLIED", attemptCount: { increment: 1 } }) }))
  })
})
