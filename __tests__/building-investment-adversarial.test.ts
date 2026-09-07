import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  solution: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import {
  applyBuildingInvestmentDecision,
  buildingInvestmentSourceFingerprint,
} from "@/lib/building-investment"

const workspaceId = "00000000-0000-4000-8000-000000000002"
const solutionId = "00000000-0000-4000-8000-000000000001"
const solution = {
  id: solutionId,
  title: "Native decisions",
  description: "Use Compass as decision authority",
  status: "VALIDATED",
  updatedAt: new Date("2026-09-02T12:00:00Z"),
  opportunity: {
    id: "00000000-0000-4000-8000-000000000003",
    title: "Trusted delivery",
    workspaceId,
  },
}

describe("Building investment adversarial boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.solution.findUnique.mockResolvedValue(solution)
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
  })

  it("stales the immutable packet when displayed opportunity evidence changes", () => {
    expect(buildingInvestmentSourceFingerprint({ ...solution, opportunity: { ...solution.opportunity, title: "Renamed opportunity" } }))
      .not.toBe(buildingInvestmentSourceFingerprint(solution))
  })

  it("rejects a concurrent receipt whose continuation is not the Building authorization", async () => {
    prisma.decisionApplication.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "receipt-winner",
        decisionId: "decision-1",
        targetId: solutionId,
        targetType: "SOLUTION",
        continuationKey: "NO_ACTION",
        status: "APPLIED",
      })
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-1",
      requestId: "request-1",
      workspaceId,
      fingerprint: "fp",
      optionId: "option-1",
      revision: {
        fingerprint: "fp",
        sourceFingerprint: buildingInvestmentSourceFingerprint(solution),
        supersededAt: null,
        options: [{ id: "option-1" }],
        request: { id: "request-1",
          workspaceId,
          gateType: "BUILDING_INVESTMENT",
          subjectType: "SOLUTION",
          subjectId: solutionId,
        },
      },
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" },
      revisionId: "revision-1",
      option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
    })
    prisma.decisionApplication.create.mockRejectedValue({ code: "P2002" })

    await expect(applyBuildingInvestmentDecision(solutionId, "decision-1"))
      .rejects.toEqual(expect.objectContaining({ code: "RECEIPT_CONFLICT" }))
  })

  it("does not create authorization evidence for a rejecting human decision", async () => {
    prisma.decisionApplication.findUnique.mockResolvedValue(null)
    prisma.decisionRecord.findUnique.mockResolvedValue({
      id: "decision-reject",
      requestId: "request-1",
      workspaceId,
      fingerprint: "fp",
      optionId: "option-reject",
      revision: {
        fingerprint: "fp",
        sourceFingerprint: buildingInvestmentSourceFingerprint(solution),
        supersededAt: null,
        options: [{ id: "option-reject" }],
        request: { id: "request-1",
          workspaceId,
          gateType: "BUILDING_INVESTMENT",
          subjectType: "SOLUTION",
          subjectId: solutionId,
        },
      },
      request: { id: "request-1", state: "DECIDED", currentRevisionId: "revision-1" },
      revisionId: "revision-1",
      option: { outcomeClass: "REJECT", continuationKey: "NO_ACTION" },
    })

    await expect(applyBuildingInvestmentDecision(solutionId, "decision-reject"))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_MISMATCH" }))
    expect(prisma.decisionApplication.create).not.toHaveBeenCalled()
  })
})
