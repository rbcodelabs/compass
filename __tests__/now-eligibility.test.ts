import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockFindPlan = vi.fn()
vi.mock("@/lib/db", () => ({ default: () => ({ portfolioCapacityPlan: { findUnique: mockFindPlan } }) }))

import { resolveNowCommitmentEligibility } from "@/lib/now-eligibility"

const ids = {
  item: "00000000-0000-4000-8000-000000000001", workspace: "00000000-0000-4000-8000-000000000002",
  solution: "00000000-0000-4000-8000-000000000003", squad: "00000000-0000-4000-8000-000000000004",
  plan: "00000000-0000-4000-8000-000000000005", reserved: "00000000-0000-4000-8000-000000000006",
}
const item = { id: ids.item, workspaceId: ids.workspace, solutionId: ids.solution, squadId: ids.squad }

function validPolicy() {
  return { version: 1, workspaces: { [ids.workspace]: {
    portfolioPolicyId: "portfolio-v1",
    capacity: { planId: ids.plan, planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, requestedUnits: 1, unitsPerNowItem: 1, nowLimit: 3 },
    investmentDecisions: { [ids.solution]: { authorityProvider: "OBSIDIAN", authorityRecordId: "DEC-1", authorityChecksum: "a".repeat(64), decisionOutcome: "APPROVE_BUILDING", applicationStatus: "APPLIED", applicationReceiptId: "receipt-1" } },
    displacementByRoadmapItemId: {} as Record<string, { itemId: string; destination: "NEXT" | "LATER" }>,
  } } }
}

describe("canonical NOW eligibility resolver", () => {
  const original = process.env.NOW_COMMITMENT_POLICY_JSON
  beforeEach(() => { vi.clearAllMocks(); delete process.env.NOW_COMMITMENT_POLICY_JSON })
  afterEach(() => { if (original === undefined) delete process.env.NOW_COMMITMENT_POLICY_JSON; else process.env.NOW_COMMITMENT_POLICY_JSON = original })

  it("fails closed when product policy configuration is absent", async () => {
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
  })

  it.each([
    ["unapproved investment", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].decisionOutcome = "REJECT" as "APPROVE_BUILDING" }],
    ["unapplied investment", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].applicationStatus = "PENDING" as "APPLIED" }],
    ["empty authority", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].authorityRecordId = "" }],
    ["forged checksum", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].authorityChecksum = "not-a-sha256" }],
    ["noninteger capacity", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.availableUnits = 1.5 }],
    ["negative capacity", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.requestedUnits = -1 }],
    ["invalid plan mapping", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.planId = "../../plan" }],
    ["open displacement enum", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].displacementByRoadmapItemId = { [ids.item]: { itemId: ids.reserved, destination: "NOW" as "NEXT" } } }],
  ])("rejects malformed policy: %s", async (_name, mutate) => {
    const policy = validPolicy(); mutate(policy); process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(policy)
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
    expect(mockFindPlan).not.toHaveBeenCalled()
  })

  it("resolves configured investment from the authoritative workspace capacity plan", async () => {
    process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(validPolicy())
    mockFindPlan.mockResolvedValue({ id: ids.plan, workspaceId: ids.workspace, policyId: "portfolio-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, nowLimit: 3, state: "ACTIVE", version: 1, reservations: [{ roadmapItemId: ids.reserved, units: 1 }] })
    await expect(resolveNowCommitmentEligibility(item)).resolves.toEqual(expect.objectContaining({
      portfolioPolicyId: "portfolio-v1",
      investmentDecision: expect.objectContaining({ subjectId: ids.solution, authorityRecordId: "DEC-1" }),
      capacity: expect.objectContaining({ reservedUnits: 1, reservedRoadmapItemIds: [ids.reserved] }),
    }))
  })
})
