import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const { ops, db, inspectPolicy } = vi.hoisted(() => ({
  ops: { create: vi.fn(), reconcile: vi.fn(), activate: vi.fn(), inspect: vi.fn() },
  db: { query: vi.fn() },
  inspectPolicy: vi.fn(),
}))
vi.mock("@/lib/capacity-plan-ops", () => ({
  CapacityPlanOpsError: class extends Error { constructor(public code: string, message: string) { super(message) } },
  createCapacityPlan: ops.create, reconcileCapacityPlan: ops.reconcile, activateCapacityPlan: ops.activate, inspectCapacityPlan: ops.inspect,
}))
vi.mock("@/lib/admin-dsql-pool", () => ({ withAdminDsqlClient: (fn: (value: unknown) => unknown) => fn(db) }))
vi.mock("@/lib/now-eligibility", () => ({ inspectConfiguredNowPolicy: inspectPolicy }))
import { GET, POST } from "@/app/api/admin/capacity-plans/route"
const originalEnv = { ...process.env }
const id = "00000000-0000-4000-8000-000000000041", fp = "a".repeat(64)
function request(method: "GET" | "POST", body?: unknown, secret = "test-secret") {
  const url = method === "GET" ? `http://localhost/api/admin/capacity-plans?planId=${id}&workspaceId=${id}` : "http://localhost/api/admin/capacity-plans"
  return new NextRequest(url, { method, headers: { "content-type": "application/json", "x-migration-secret": secret }, body: body === undefined ? undefined : JSON.stringify(body) })
}
beforeEach(() => {
  vi.clearAllMocks()
  process.env.MIGRATION_SECRET = "test-secret"
  inspectPolicy.mockReturnValue({ runtimePolicyReady: false, effectiveMode: "off" })
  db.query.mockRejectedValue(new Error("not configured"))
})
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
    expect(ops.activate).toHaveBeenCalledWith(db, expect.objectContaining({ expectedVersion: 1, idempotencyKey: "activate-1" }))
  })
  it("supports read-only inspect and rejects unknown or extra fields", async () => {
    ops.inspect.mockResolvedValue({ plan: { workspace_id: id }, capacityMetadataReady: false, runtimeEnforcementReady: false })
    expect((await GET(request("GET"))).status).toBe(200)
    expect((await POST(request("POST", { action: "other" }))).status).toBe(400)
    expect((await POST(request("POST", { action: "reconcile", planId: id, expectedPlanFingerprint: fp, expectedVersion: 0, idempotencyKey: "k", surprise: true }))).status).toBe(400)
  })
  it("does not treat stale shadow evidence as readiness for the current signed policy", async () => {
    process.env.NOW_DECISION_GATE_MODE = "shadow"
    ops.inspect.mockResolvedValue({ plan: { workspace_id: id }, capacityMetadataReady: true })
    inspectPolicy.mockReturnValue({
      runtimePolicyReady: true,
      effectiveMode: "shadow",
      policyArtifactId: `now-policy:v1:sha256:${"b".repeat(64)}`,
      routingFingerprint: `sha256:${"c".repeat(64)}`,
      capacityPlanId: id,
      capacityPlanFingerprint: fp,
      generatedAt: "2026-09-02T12:00:00.000Z",
    })
    db.query
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // only historical evidence exists; current policy has no match
      .mockResolvedValueOnce({ rows: [
        { migration_name: "039_native_decision_gates" },
        { migration_name: "040_release_authorization" },
        { migration_name: "041_portfolio_capacity_ledger" },
        { migration_name: "043_decision_evidence_refs" },
        { migration_name: "044_now_policy_application_evidence" },
        { migration_name: "045_now_gate_shadow_evaluations" },
      ] })

    const response = await GET(request("GET"))
    expect(response.status).toBe(200)
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringMatching(/policy_artifact_id=\$2[\s\S]*routing_fingerprint=\$3[\s\S]*capacity_plan_id=\$4[\s\S]*capacity_plan_fingerprint=\$5/), [
      id,
      `now-policy:v1:sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
      id,
      fp,
      new Date("2026-09-02T12:00:00.000Z"),
    ])
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      shadowTelemetryReady: false,
      shadowEvaluationReady: false,
      runtimeEnforcementReady: false,
    }))
  })
})
