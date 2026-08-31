import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockFindMany = vi.fn()
vi.mock("@/lib/db", () => ({ default: () => ({ roadmapItem: { findMany: mockFindMany } }) }))

import { resolveNowCommitmentEligibility } from "@/lib/now-eligibility"

const item = { id: "item-1", workspaceId: "ws-1", solutionId: "sol-1", squadId: "squad-1" }

describe("canonical NOW eligibility resolver", () => {
  const original = process.env.NOW_COMMITMENT_POLICY_JSON

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.NOW_COMMITMENT_POLICY_JSON
  })

  afterEach(() => {
    if (original === undefined) delete process.env.NOW_COMMITMENT_POLICY_JSON
    else process.env.NOW_COMMITMENT_POLICY_JSON = original
  })

  it("fails closed when product policy configuration is absent", async () => {
    await expect(resolveNowCommitmentEligibility(item))
      .rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
  })

  it("resolves configured investment and live reserved capacity without caller injection", async () => {
    process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify({
      version: 1,
      workspaces: {
        "ws-1": {
          portfolioPolicyId: "portfolio-v1",
          capacity: { planId: "focus-2026-q3", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, requestedUnits: 1, unitsPerNowItem: 1, nowLimit: 3 },
          investmentDecisions: {
            "sol-1": { authorityProvider: "OBSIDIAN", authorityRecordId: "DEC-1", authorityChecksum: "a".repeat(64), decisionOutcome: "APPROVE_BUILDING", applicationStatus: "APPLIED", applicationReceiptId: "receipt-1" },
          },
        },
      },
    })
    mockFindMany.mockResolvedValue([{ id: "now-2" }, { id: "now-1" }])

    await expect(resolveNowCommitmentEligibility(item)).resolves.toEqual(expect.objectContaining({
      portfolioPolicyId: "portfolio-v1",
      investmentDecision: expect.objectContaining({ subjectId: "sol-1", authorityRecordId: "DEC-1" }),
      capacity: expect.objectContaining({ reservedUnits: 2, reservedRoadmapItemIds: ["now-1", "now-2"] }),
    }))
  })
})
