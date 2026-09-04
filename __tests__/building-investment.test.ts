import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const prisma = {
  solution: { findUnique: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  reviewRevision: { create: vi.fn(), update: vi.fn() },
  decisionRecord: { findUnique: vi.fn(), findFirst: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { applyBuildingInvestmentDecision, applyBuildingInvestmentRevocationDecision, buildingInvestmentSourceFingerprint, prepareBuildingInvestmentReview, prepareBuildingInvestmentRevocationReview, startNewBuildingInvestmentDecisionCycle } from "@/lib/building-investment"
import { investmentAuthorityChecksum } from "@/lib/native-decision-evidence"

const solution = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Native decisions",
  description: "Use Compass as decision authority",
  status: "VALIDATED",
  updatedAt: new Date("2026-09-02T12:00:00Z"),
  opportunity: { workspaceId: "00000000-0000-4000-8000-000000000002", id: "00000000-0000-4000-8000-000000000003", title: "Trusted delivery" },
}
const authorityReceipt = { id: "authority-receipt", status: "APPLIED", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solution.id }
function authorityFixture() { return {
  id: "authority-1", workspaceId: solution.opportunity.workspaceId, requestId: "authority-request", revisionId: "authority-revision", optionId: "authority-option", fingerprint: "a".repeat(64), decidedAt: new Date("2026-09-02T12:00:00Z"),
  request: { id: "authority-request", state: "DECIDED", currentRevisionId: "authority-revision" },
  revision: { fingerprint: "a".repeat(64), sourceFingerprint: buildingInvestmentSourceFingerprint(solution), supersededAt: null, options: [{ id: "authority-option" }], request: { id: "authority-request", workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: solution.id } },
  option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" }, applications: [authorityReceipt],
} }

describe("Building investment decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.solution.findUnique.mockResolvedValue(solution)
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    prisma.reviewRequest.create.mockResolvedValue({ id: "request-1", revisionCount: 0, decisionCycle: 1 })
    prisma.reviewRevision.create.mockResolvedValue({ id: "revision-1", requestId: "request-1", fingerprint: "fingerprint" })
    prisma.reviewRequest.updateMany.mockResolvedValue({ count: 1 })
  })

  it("prepares an immutable admin review bound to the exact Solution and workspace", async () => {
    await prepareBuildingInvestmentReview(solution.id, { requestedById: "user-1" })

    expect(prisma.reviewRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId: solution.opportunity.workspaceId,
      gateType: "BUILDING_INVESTMENT",
      subjectType: "SOLUTION",
      subjectId: solution.id,
      requestedById: "user-1",
    }) })
    expect(prisma.reviewRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      requiredRole: "ADMIN",
      options: { create: expect.arrayContaining([
        expect.objectContaining({ actionKey: "APPROVE_BUILDING", outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" }),
      ]) },
    }) })
  })

  it("returns the current pending revision for identical material inputs", async () => {
    const sourceFingerprint = buildingInvestmentSourceFingerprint(solution)
    prisma.reviewRequest.findFirst.mockResolvedValue({
      id: "request-1", state: "PENDING", revisionCount: 1, decisionCycle: 1,
      currentRevisionId: "revision-1", currentRevision: { id: "revision-1", sourceFingerprint },
    })

    const replay = await prepareBuildingInvestmentReview(solution.id)

    expect(replay).toEqual(expect.objectContaining({ id: "revision-1" }))
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("creates one APPLIED authorization receipt for an approved exact-subject decision", async () => {
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-1", requestId: "request-1", workspaceId: solution.opportunity.workspaceId,
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" }, revisionId: "revision-1",
      revision: { fingerprint: "fp", sourceFingerprint: buildingInvestmentSourceFingerprint(solution), supersededAt: null, options: [{ id: "option-1" }], request: { id: "request-1", workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: solution.id } },
      fingerprint: "fp", optionId: "option-1", option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
    })
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
    prisma.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })

    await expect(applyBuildingInvestmentDecision(solution.id, "decision-1")).resolves.toEqual(expect.objectContaining({ id: "receipt-1", status: "APPLIED" }))
    expect(prisma.decisionApplication.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      decisionId: "decision-1", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solution.id, status: "APPLIED",
    }) })
  })

  it("fails closed for a cross-workspace or wrong-subject decision", async () => {
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-1", requestId: "request-1", workspaceId: "00000000-0000-4000-8000-000000000099", fingerprint: "fp",
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" }, revisionId: "revision-1",
      revision: { fingerprint: "fp", sourceFingerprint: buildingInvestmentSourceFingerprint(solution), supersededAt: null, options: [{ id: "option-1" }], request: { id: "request-1", workspaceId: "00000000-0000-4000-8000-000000000099", gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: solution.id } },
      optionId: "option-1", option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
    })

    await expect(applyBuildingInvestmentDecision(solution.id, "decision-1")).rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })

  it("prepares an immutable revocation review bound to an applied authority", async () => {
    prisma.decisionRecord.findUnique.mockResolvedValue(authorityFixture())
    await prepareBuildingInvestmentRevocationReview(solution.id, "authority-1", { requestedById: "user-1" })
    expect(prisma.reviewRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ gateType: "BUILDING_INVESTMENT_REVOCATION", subjectId: solution.id }) })
    expect(prisma.reviewRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ options: { create: expect.arrayContaining([expect.objectContaining({ continuationKey: "REVOKE_BUILDING_INVESTMENT" })]) } }) })
  })

  it("applies a revocation receipt only for the exact historical authority", async () => {
    const authority = authorityFixture()
    prisma.decisionRecord.findUnique.mockResolvedValue(authority)
    await prepareBuildingInvestmentRevocationReview(solution.id, "authority-1", { requestedById: "user-1" })
    const created = prisma.reviewRevision.create.mock.calls.at(-1)?.[0]?.data
    const sourceFingerprint = created?.sourceFingerprint
    prisma.decisionRecord.findUnique.mockReset()
    prisma.decisionRecord.findUnique.mockResolvedValueOnce({ id: "revocation-1", requestId: "request-1", workspaceId: solution.opportunity.workspaceId, revisionId: "revision-1", optionId: "option-1", fingerprint: "fp", request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" }, revision: { fingerprint: "fp", sourceFingerprint, packetJson: created.packetJson, supersededAt: null, options: [{ id: "option-1" }], request: { id: "request-1", workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: solution.id } }, option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" } }).mockResolvedValueOnce(authority)
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
    prisma.decisionApplication.create.mockResolvedValue({ id: "revocation-receipt", status: "APPLIED" })
    await expect(applyBuildingInvestmentRevocationDecision(solution.id, "revocation-1")).resolves.toEqual(expect.objectContaining({ status: "APPLIED" }))
  })

  it("starts a new approval cycle only after the exact authority has an applied revocation", async () => {
    const authority = authorityFixture()
    prisma.reviewRequest.findFirst.mockResolvedValue({
      id: "request-1", state: "DECIDED", revisionCount: 1, decisionCycle: 1, currentRevisionId: "revision-1",
      currentRevision: { id: "revision-1", decisions: [authority] },
    })
    const revocationSource = createHash("sha256").update(JSON.stringify({
      gateType: "BUILDING_INVESTMENT_REVOCATION",
      solutionSourceFingerprint: buildingInvestmentSourceFingerprint(solution),
      authorityDecisionId: "authority-1", authorityReceiptId: authorityReceipt.id,
      authorityChecksum: investmentAuthorityChecksum(authority, authorityReceipt.id),
    })).digest("hex")
    prisma.decisionRecord.findFirst.mockResolvedValue({
      id: "revocation-1", workspaceId: solution.opportunity.workspaceId, requestId: "revocation-request", revisionId: "revocation-revision", optionId: "revocation-option", fingerprint: "revocation-fp",
      request: { id: "revocation-request", state: "DECIDED", currentRevisionId: "revocation-revision" },
      revision: { fingerprint: "revocation-fp", sourceFingerprint: revocationSource, supersededAt: null, packetJson: JSON.stringify({ authorityDecisionId: "authority-1", authorityReceiptId: authorityReceipt.id, authorityChecksum: investmentAuthorityChecksum(authority, authorityReceipt.id), solution: { id: solution.id } }), options: [{ id: "revocation-option" }], request: { id: "revocation-request", workspaceId: solution.opportunity.workspaceId } },
      option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" },
      applications: [{ status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solution.id }],
    })

    await expect(startNewBuildingInvestmentDecisionCycle(solution.id, { reason: "Corrected evidence", actorUserId: "user-1", expectedTerminalDecisionId: "authority-1" })).resolves.toEqual(expect.objectContaining({ id: "revision-1" }))
    expect(prisma.reviewRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ decisionCycle: 2, state: "PENDING", reconsidersDecisionId: "authority-1" }) })
  })
})
