import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  disconnect: vi.fn(),
  findWorkspace: vi.fn(),
  repair: vi.fn(),
}))

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class MockPrismaPg {
    constructor(pool: unknown, options: unknown) {
      mocks.adapter(pool, options)
    }
  },
}))
vi.mock("@prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    workspace = { findUnique: mocks.findWorkspace }
    $disconnect = mocks.disconnect
  },
}))
vi.mock("@/lib/legacy-decision-repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legacy-decision-repair")>()
  return { ...actual, repairLegacyDecisionRequests: mocks.repair }
})

import {
  applyLegacyDecisionReviewRepair,
  getLegacyDecisionReviewRepairStatus,
} from "@/lib/migrations/legacy-decision-review-repair"

const pool = { end: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.findWorkspace.mockResolvedValue({ id: "3eaf938a-782c-4073-a452-070d54156896" })
})

describe("legacy decision review migration hook", () => {
  it("treats an absent allowlisted workspace as a safe environment no-op", async () => {
    mocks.findWorkspace.mockResolvedValueOnce(null)

    await expect(applyLegacyDecisionReviewRepair(pool as never, "compass_preview")).resolves.toMatchObject({
      workspaceStatus: "NOT_PRESENT",
      requests: [],
    })
    expect(mocks.repair).not.toHaveBeenCalled()
    expect(mocks.adapter).toHaveBeenCalledWith(pool, { schema: "compass_preview", disposeExternalPool: false })
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(pool.end).not.toHaveBeenCalled()
  })

  it.each(["ERROR", "NOT_ELIGIBLE", "READY"])("rejects a non-terminal %s request before receipt completion", async (status) => {
    mocks.repair.mockResolvedValueOnce({
      mode: "APPLY",
      workspaceId: "3eaf938a-782c-4073-a452-070d54156896",
      requests: [{ requestId: "bde7e2b0-21c1-489e-9d54-91bf3d7580b0", status, message: "not terminal" }],
    })

    await expect(applyLegacyDecisionReviewRepair(pool as never, "compass_prod")).rejects.toThrow("did not reach a terminal postcondition")
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it("accepts decided requests as intentionally untouched terminal results", async () => {
    mocks.repair.mockResolvedValueOnce({
      mode: "APPLY",
      workspaceId: "3eaf938a-782c-4073-a452-070d54156896",
      requests: [{ requestId: "bde7e2b0-21c1-489e-9d54-91bf3d7580b0", status: "SKIPPED_DECIDED", message: "untouched" }],
    })

    await expect(applyLegacyDecisionReviewRepair(pool as never, "compass_prod")).resolves.toMatchObject({
      requests: [{ status: "SKIPPED_DECIDED" }],
    })
  })

  it("reports a missing review table as unavailable preflight", async () => {
    mocks.findWorkspace.mockRejectedValueOnce(Object.assign(new Error("missing table"), { code: "P2021" }))

    await expect(getLegacyDecisionReviewRepairStatus(pool as never, "fresh_schema")).resolves.toEqual({
      available: false,
      reason: "Review tables are not provisioned in this schema.",
    })
  })

  it("propagates unexpected database errors from preflight", async () => {
    mocks.findWorkspace.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "P1001" }))

    await expect(getLegacyDecisionReviewRepairStatus(pool as never, "compass_prod")).rejects.toThrow("connection lost")
  })
})
