import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const ops = vi.hoisted(() => ({ create: vi.fn(), reconcile: vi.fn(), activate: vi.fn(), inspect: vi.fn() }))
vi.mock("@/lib/capacity-plan-ops", () => ({
  CapacityPlanOpsError: class extends Error { constructor(public code: string, message: string) { super(message) } },
  createCapacityPlan: ops.create, reconcileCapacityPlan: ops.reconcile, activateCapacityPlan: ops.activate, inspectCapacityPlan: ops.inspect,
}))
vi.mock("@/lib/admin-dsql-pool", () => ({ withAdminDsqlClient: (fn: (db: unknown) => unknown) => fn({}) }))
import { GET, POST } from "@/app/api/admin/capacity-plans/route"
const originalEnv = { ...process.env }
const id = "00000000-0000-4000-8000-000000000041", fp = "a".repeat(64)
function request(method: "GET" | "POST", body?: unknown, secret = "test-secret") {
  const url = method === "GET" ? `http://localhost/api/admin/capacity-plans?planId=${id}` : "http://localhost/api/admin/capacity-plans"
  return new NextRequest(url, { method, headers: { "content-type": "application/json", "x-migration-secret": secret }, body: body === undefined ? undefined : JSON.stringify(body) })
}
beforeEach(() => { vi.clearAllMocks(); process.env.MIGRATION_SECRET = "test-secret" })
afterEach(() => { process.env = { ...originalEnv } })
describe("authenticated capacity plan operator route", () => {
  it("fails closed before database access when the secret is absent or wrong", async () => {
    expect((await GET(request("GET", undefined, "wrong"))).status).toBe(401)
    expect(ops.inspect).not.toHaveBeenCalled()
  })
  it("maps the exact v1 action contract and never activates during reconcile", async () => {
    const create = { action: "create", workspaceId: id, policyId: "obsidian:capacity:v1", unit: "FOCUS_SLOT", availableUnits: 4, unitsPerNowItem: 1, nowLimit: 4, idempotencyKey: "create-1" }
    const reconcile = { action: "reconcile", planId: id, expectedPlanFingerprint: fp, expectedVersion: 0, idempotencyKey: "reconcile-1" }
    const activate = { action: "activate", planId: id, expectedPlanFingerprint: fp, expectedVersion: 1, expectedNowSnapshotFingerprint: fp, idempotencyKey: "activate-1" }
    ops.create.mockResolvedValue({}); ops.reconcile.mockResolvedValue({}); ops.activate.mockResolvedValue({})
    expect((await POST(request("POST", create))).status).toBe(200)
    expect((await POST(request("POST", reconcile))).status).toBe(200)
    expect(ops.activate).not.toHaveBeenCalled()
    expect((await POST(request("POST", activate))).status).toBe(200)
    expect(ops.activate).toHaveBeenCalledWith({}, expect.objectContaining({ expectedVersion: 1, idempotencyKey: "activate-1" }))
  })
  it("supports read-only inspect and rejects unknown or extra fields", async () => {
    ops.inspect.mockResolvedValue({ runtimeEnforcementReady: false })
    expect((await GET(request("GET"))).status).toBe(200)
    expect((await POST(request("POST", { action: "other" }))).status).toBe(400)
    expect((await POST(request("POST", { action: "reconcile", planId: id, expectedPlanFingerprint: fp, expectedVersion: 0, idempotencyKey: "k", surprise: true }))).status).toBe(400)
  })
})
