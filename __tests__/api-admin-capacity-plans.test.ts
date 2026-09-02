import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const ops = vi.hoisted(() => ({ create: vi.fn(), reconcile: vi.fn(), activate: vi.fn(), inspect: vi.fn() }))
vi.mock("@/lib/capacity-plan-ops", () => ({
  CapacityPlanOpsError: class extends Error { constructor(public code: string, message: string) { super(message) } },
  createCapacityPlan: ops.create,
  reconcileCapacityPlan: ops.reconcile,
  activateCapacityPlan: ops.activate,
  inspectCapacityPlan: ops.inspect,
}))
vi.mock("@/lib/admin-dsql-pool", () => ({ withAdminDsqlClient: (fn: (db: unknown) => unknown) => fn({}) }))

import { GET, POST } from "@/app/api/admin/capacity-plans/route"
const originalEnv = { ...process.env }
const id = "00000000-0000-4000-8000-000000000041"

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

  it("maps explicit create, reconcile, and activate actions without implicit activation", async () => {
    ops.create.mockResolvedValue({ created: true })
    ops.reconcile.mockResolvedValue({ created: 2 })
    ops.activate.mockResolvedValue({ activated: true })
    expect((await POST(request("POST", { action: "create", workspaceId: id, policyId: "p", planFingerprint: "a".repeat(64), unit: "week", availableUnits: 4, unitsPerNowItem: 2, nowLimit: 2 }))).status).toBe(200)
    expect((await POST(request("POST", { action: "reconcile", planId: id }))).status).toBe(200)
    expect(ops.activate).not.toHaveBeenCalled()
    expect((await POST(request("POST", { action: "activate", planId: id, expectedVersion: 0, planFingerprint: "a".repeat(64) }))).status).toBe(200)
    expect(ops.activate).toHaveBeenCalledWith({}, { planId: id, expectedVersion: 0, planFingerprint: "a".repeat(64) })
  })

  it("supports read-only inspect and rejects unknown actions", async () => {
    ops.inspect.mockResolvedValue({ plan: { id } })
    expect((await GET(request("GET"))).status).toBe(200)
    expect((await POST(request("POST", { action: "other" }))).status).toBe(400)
  })
})
