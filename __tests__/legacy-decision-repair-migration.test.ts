import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  disconnect: vi.fn(),
  findWorkspace: vi.fn(),
  repair: vi.fn(),
  createPool: vi.fn(),
  endInspectionPool: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock("pg", () => ({
  Pool: class MockPool {
    end = mocks.endInspectionPool
    constructor(options: unknown) { mocks.createPool(options) }
  },
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
    $transaction = mocks.transaction
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
afterEach(() => vi.unstubAllEnvs())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repair.mockReset()
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.findWorkspace.mockResolvedValue({ id: "3eaf938a-782c-4073-a452-070d54156896" })
  mocks.transaction.mockReset().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => callback({ workspace: { findUnique: mocks.findWorkspace } }))
})

describe("legacy decision review migration hook", () => {
  it("uses the original-config factory without reflecting on the caller pool", async () => {
    const originalPool = { get options() { throw new Error("caller options must not be reflected") } }
    const inspectionPool = { end: mocks.endInspectionPool }
    const factory = vi.fn(() => inspectionPool as never)
    mocks.findWorkspace.mockResolvedValueOnce(null)
    await expect(getLegacyDecisionReviewRepairStatus(originalPool as never, "compass_prod", factory)).resolves.toMatchObject({ available: true })
    expect(factory).toHaveBeenCalledOnce()
    expect(mocks.createPool).not.toHaveBeenCalled()
    expect(mocks.adapter).toHaveBeenCalledWith(inspectionPool, { schema: "compass_prod", disposeExternalPool: false })
    expect(mocks.endInspectionPool).toHaveBeenCalledOnce()
  })

  it("preserves a real pg Pool's non-enumerable IAM password callback", async () => {
    const { Pool: RealPool } = await vi.importActual<typeof import("pg")>("pg")
    const password = vi.fn(async () => "synthetic-iam-token")
    const original = new RealPool({ host: "synthetic.dsql.example", password, ssl: true })
    expect(Object.keys(original.options)).not.toContain("password")
    mocks.findWorkspace.mockResolvedValueOnce(null)
    try {
      await getLegacyDecisionReviewRepairStatus(original, "compass_prod")
      expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ password }))
    } finally { await original.end() }
  })

  it("omits unsupported statement_timeout from DSQL inspection startup options", async () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("DATABASE_MIGRATION_URL", "")
    vi.stubEnv("POSTGRES_URL", "")
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "")
    mocks.findWorkspace.mockResolvedValueOnce(null)
    await getLegacyDecisionReviewRepairStatus(pool as never, "compass_prod")
    expect(mocks.createPool.mock.calls[0][0]).not.toHaveProperty("statement_timeout")
    expect(mocks.createPool.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 1000, query_timeout: 2000 })
  })

  it("inspects with its own bounded pool when the caller's only connection is occupied", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost/compass_e2e")
    const occupiedPool = { options: { max: 1, host: "localhost" }, connect: vi.fn(() => new Promise(() => {})) }
    mocks.transaction.mockImplementationOnce(async (callback: (client: unknown) => Promise<unknown>) => callback({ workspace: { findUnique: mocks.findWorkspace } }))
    mocks.findWorkspace.mockResolvedValueOnce(null)

    await expect(getLegacyDecisionReviewRepairStatus(occupiedPool as never, "compass_prod")).resolves.toMatchObject({ available: true, workspaceStatus: "NOT_PRESENT" })
    expect(occupiedPool.connect).not.toHaveBeenCalled()
    expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ host: "localhost", max: 1, connectionTimeoutMillis: 1000, query_timeout: 2000, statement_timeout: 2000 }))
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 1000, timeout: 5000 })
    expect(mocks.endInspectionPool).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it("cleans up the bounded inspection pool after acquisition or execution timeout", async () => {
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("transaction timed out"), { code: "P2028" }))
    mocks.repair.mockResolvedValueOnce({ mode: "DRY_RUN", workspaceId: "test", requests: [] })
    await expect(getLegacyDecisionReviewRepairStatus(pool as never, "compass_prod")).rejects.toThrow("transaction timed out")
    expect(mocks.endInspectionPool).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(mocks.repair).not.toHaveBeenCalled()
  })

  it("propagates connection failure during explicit apply and disconnects", async () => {
    mocks.findWorkspace.mockRejectedValueOnce(Object.assign(new Error("synthetic connection failure"), { code: "P1001" }))

    await expect(applyLegacyDecisionReviewRepair(pool as never, "compass_prod")).rejects.toThrow("synthetic connection failure")
    expect(mocks.repair).not.toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(pool.end).not.toHaveBeenCalled()
  })

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
