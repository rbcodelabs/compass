import { describe, expect, it, vi } from "vitest"
import { capacityOperationPreflight, createCapacityPlan, inspectCapacityPlan } from "@/lib/capacity-plan-ops"
const workspaceId = "00000000-0000-4000-8000-000000000001"
const planId = "00000000-0000-4000-8000-000000000041"
const plan = { id: planId, workspace_id: workspaceId, policy_id: "obsidian:v1", plan_fingerprint: "a".repeat(64), unit: "FOCUS_SLOT", available_units: 3, units_per_now_item: 1, now_limit: 3, state: "ACTIVE", active_workspace_id: workspaceId, now_snapshot_fingerprint: "b".repeat(64), now_snapshot_count: 1, reconciled_at: new Date().toISOString(), version: 2 }
describe("capacity plan operator invariants", () => {
  it.each([
    undefined,
    { row_count: "not-a-number", estimated_bytes: "1" },
    { row_count: "1", estimated_bytes: "unknown" },
    { row_count: "2901", estimated_bytes: "1" },
    { row_count: "1", estimated_bytes: String(9 * 1024 * 1024 + 1) },
  ])("fails closed for unavailable, malformed, or unsafe operation estimates", (row) => {
    expect(capacityOperationPreflight(row)).toMatchObject({ passed: false })
  })
  it("accepts a safe numeric estimate", () => {
    expect(capacityOperationPreflight({ row_count: "2900", estimated_bytes: String(9 * 1024 * 1024) })).toMatchObject({ available: true, passed: true })
  })
  it("rejects non-v1 units before querying", async () => {
    const db = { query: vi.fn() }
    await expect(createCapacityPlan(db, { workspaceId, policyId: "p", unit: "WEEK" as never, availableUnits: 1, unitsPerNowItem: 1, nowLimit: 1, idempotencyKey: "k" })).rejects.toMatchObject({ code: "INVALID_INPUT" })
    expect(db.query).not.toHaveBeenCalled()
  })
  it("inspect returns full identities, drift and explicitly denies runtime authority", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099"
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [plan] })
      .mockResolvedValueOnce({ rows: [{ id: itemId }] })
      .mockResolvedValueOnce({ rows: [{ id: "r1", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: itemId, units: 1, state: "ACTIVE", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }] })
      .mockResolvedValueOnce({ rows: [] })
    const result = await inspectCapacityPlan({ query }, planId)
    expect(result).toMatchObject({ plan, missingItemIds: [], staleReservationIds: [], capacityMetadataReady: false, runtimeEnforcementReady: false })
    expect(result.reservations).toEqual([expect.objectContaining({ id: "r1", roadmapItemId: itemId, state: "ACTIVE" })])
    expect(result).toHaveProperty("liveNowSnapshotFingerprint")
    expect(query.mock.calls.every(([sql]) => !/\\b(?:INSERT|UPDATE|DELETE)\\b/i.test(String(sql)))).toBe(true)
  })
})
