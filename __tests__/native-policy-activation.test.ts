import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  portfolioCapacityPlan: { findFirst: vi.fn() }, decisionRecord: { findMany: vi.fn(), findUnique: vi.fn() },
  solution: { findMany: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, reviewRevision: { create: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() }, $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))
import { applyNativePolicyActivationDecision, prepareNativePolicyActivationReview } from "@/lib/native-policy-activation"
import { generateNativeNowPolicy, nativePolicyCandidateFingerprint } from "@/lib/native-now-policy"
import { nativeRoutingFingerprint, nativeRoutingManifestJson } from "@/__tests__/fixtures/native-routing"

const ws = "00000000-0000-4000-8000-000000000001"
describe("native policy activation decision", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = nativeRoutingManifestJson; prisma.solution.findMany.mockResolvedValue([]); prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma)) })
  it("prepares a human-admin activation review for the exact generated candidate", async () => {
    prisma.portfolioCapacityPlan.findFirst.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000002", workspaceId: ws, activeWorkspaceId: ws, state: "ACTIVE", policyId: "p", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, version: 1 })
    prisma.decisionRecord.findMany.mockResolvedValue([])
    prisma.reviewRequest.findFirst.mockResolvedValue(null); prisma.reviewRequest.create.mockResolvedValue({ id: "request-1" })
    prisma.reviewRevision.create.mockResolvedValue({ id: "revision-1", requestId: "request-1" })
    await prepareNativePolicyActivationReview(ws, { routingFingerprint: nativeRoutingFingerprint, mode: "enforce", requestedById: "user-1" })
    expect(prisma.reviewRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ requiredRole: "ADMIN", sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), options: { create: expect.arrayContaining([expect.objectContaining({ continuationKey: "AUTHORIZE_NOW_POLICY" })]) } }) })
  })

  it("applies one receipt only for the current exact approved activation", async () => {
    prisma.portfolioCapacityPlan.findFirst.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000002", workspaceId: ws, activeWorkspaceId: ws, state: "ACTIVE", policyId: "p", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, version: 1 })
    prisma.decisionRecord.findMany.mockResolvedValue([])
    const routingFingerprint = nativeRoutingFingerprint
    const sourceFingerprint = nativePolicyCandidateFingerprint(await generateNativeNowPolicy(ws, prisma as never), routingFingerprint, "enforce")
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
    prisma.decisionRecord.findUnique.mockResolvedValue({ id: "decision-1", requestId: "request-1", workspaceId: ws, revisionId: "revision-1", optionId: "option-1", fingerprint: "f", request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" }, revision: { fingerprint: "f", sourceFingerprint, packetJson: JSON.stringify({ routingFingerprint, mode: "enforce" }), supersededAt: null, options: [{ id: "option-1" }], request: { id: "request-1", workspaceId: ws, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: ws } }, option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" } })
    prisma.decisionApplication.create.mockResolvedValue({ id: "receipt-1", status: "APPLIED" })
    await expect(applyNativePolicyActivationDecision(ws, "decision-1")).resolves.toEqual(expect.objectContaining({ status: "APPLIED" }))
  })
})
