import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  portfolioCapacityPlan: { findFirst: vi.fn() },
  solution: { findMany: vi.fn() },
  decisionRecord: { findMany: vi.fn(), findUnique: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  reviewRevision: { create: vi.fn(), update: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { applyNativePolicyActivationDecision, prepareNativePolicyActivationReview } from "@/lib/native-policy-activation"
import { generateNativeNowPolicy, nativePolicyCandidateFingerprint } from "@/lib/native-now-policy"
import { nativeRoutingFingerprint, nativeRoutingManifestJson } from "@/__tests__/fixtures/native-routing"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const routingFingerprint = nativeRoutingFingerprint

describe("native policy activation adversarial boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = nativeRoutingManifestJson
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.portfolioCapacityPlan.findFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002", workspaceId, activeWorkspaceId: workspaceId,
      state: "ACTIVE", policyId: "policy-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT",
      availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, version: 1,
    })
    prisma.solution.findMany.mockResolvedValue([])
    prisma.decisionRecord.findMany.mockResolvedValue([])
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
  })

  it("cannot supersede a workspace activation with an unrelated terminal decision ID", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue({
      id: "request-1", state: "DECIDED", currentRevisionId: "revision-1", revisionCount: 1, decisionCycle: 1,
      currentRevision: { id: "revision-1", sourceFingerprint: "old", decisions: [{ id: "terminal-real" }] },
    })

    await expect(prepareNativePolicyActivationReview(workspaceId, {
      routingFingerprint, mode: "enforce", expectedTerminalDecisionId: "terminal-unrelated", reason: "Rotate policy",
    })).rejects.toEqual(expect.objectContaining({ code: "ACTIVATION_CYCLE_REQUIRED" }))
    expect(prisma.reviewRevision.update).not.toHaveBeenCalled()
    expect(prisma.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("does not apply an activation decision after its generated candidate changes", async () => {
    const generated = await generateNativeNowPolicy(workspaceId, prisma as never)
    const staleSource = nativePolicyCandidateFingerprint(generated, routingFingerprint, "enforce")
    prisma.portfolioCapacityPlan.findFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002", workspaceId, activeWorkspaceId: workspaceId,
      state: "ACTIVE", policyId: "policy-v2", planFingerprint: "c".repeat(64), unit: "FOCUS_SLOT",
      availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, version: 2,
    })
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-1", requestId: "request-1", workspaceId, revisionId: "revision-1", optionId: "option-1", fingerprint: "fp",
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" },
      revision: { fingerprint: "fp", sourceFingerprint: staleSource, packetJson: JSON.stringify({ routingFingerprint, mode: "enforce" }), supersededAt: null, options: [{ id: "option-1" }], request: { id: "request-1", workspaceId, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: workspaceId } },
      option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" },
    })

    await expect(applyNativePolicyActivationDecision(workspaceId, "decision-1"))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })

  it("never creates an activation receipt for a rejection", async () => {
    const source = nativePolicyCandidateFingerprint(await generateNativeNowPolicy(workspaceId, prisma as never), routingFingerprint, "enforce")
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-reject", requestId: "request-1", workspaceId, revisionId: "revision-1", optionId: "option-reject", fingerprint: "fp",
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" },
      revision: { fingerprint: "fp", sourceFingerprint: source, packetJson: JSON.stringify({ routingFingerprint, mode: "enforce" }), supersededAt: null, options: [{ id: "option-reject" }], request: { id: "request-1", workspaceId, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: workspaceId } },
      option: { outcomeClass: "REJECT", continuationKey: "NO_ACTION" },
    })

    await expect(applyNativePolicyActivationDecision(workspaceId, "decision-reject"))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })
})
