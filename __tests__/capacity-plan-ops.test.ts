import { describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"
import { activateCapacityPlan, capacityOperationPreflight, createCapacityPlan, inspectCapacityPlan, reconcileCapacityPlan, type SqlClient } from "@/lib/capacity-plan-ops"
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
  it("rejects out-of-range int32 capacity before querying", async () => {
    const db = { query: vi.fn() }
    await expect(createCapacityPlan(db, { workspaceId, policyId: "p", unit: "FOCUS_SLOT", availableUnits: 2_147_483_648, unitsPerNowItem: 1, nowLimit: 1, idempotencyKey: "k" })).rejects.toMatchObject({ code: "INVALID_INPUT" })
    expect(db.query).not.toHaveBeenCalled()
  })
  it("returns a committed reconcile receipt before rejecting its now-stale version", async () => {
    const stored = { action: "RECONCILE", operationId: "op-1", runtimeEnforcementReady: false }
    const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-operation/v1", action: "RECONCILE", semantic: { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1 } })).digest("hex")
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...plan, state: "DRAFT", version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: "op-1", action: "RECONCILE", request_fingerprint: requestFingerprint, status: "SUCCEEDED", result_json: JSON.stringify(stored) }] })
    await expect(reconcileCapacityPlan({ query }, { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, idempotencyKey: "retry-1" })).resolves.toEqual(stored)
    expect(query).toHaveBeenCalledTimes(2)
  })
  it("executes a fresh reconcile with durable preflight, reservation, cursor, CAS, receipt and commit", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099"
    const draft = { ...plan, state: "DRAFT", active_workspace_id: null, version: 0 }
    const updated = { ...draft, version: 1, now_snapshot_fingerprint: "c".repeat(64), now_snapshot_count: 1 }
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [draft] }) // plan
      .mockResolvedValueOnce({ rows: [] }) // receipt lookup
      .mockResolvedValueOnce({ rows: [{ id: "op", action: "RECONCILE", request_fingerprint: crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-operation/v1", action: "RECONCILE", semantic: { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 0 } })).digest("hex"), status: "IN_PROGRESS", result_json: null }] }) // receipt insert
      .mockResolvedValueOnce({ rows: [{ id: itemId }] }) // initial NOW
      .mockResolvedValueOnce({ rows: [] }) // old reservations
      .mockResolvedValueOnce({ rows: [{ row_count: "1", estimated_bytes: "128" }] }) // bounded preflight
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // reservation insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // durable cursor
      .mockResolvedValueOnce({ rows: [{ id: itemId }] }) // exact NOW
      .mockResolvedValueOnce({ rows: [{ id: "r", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: null, units: 1, state: "STAGED", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }] })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }) // plan CAS
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // receipt complete
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    const result = await reconcileCapacityPlan({ query }, { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 0, idempotencyKey: "fresh" })
    expect(result).toMatchObject({ action: "RECONCILE", stagedItemIds: [itemId], runtimeEnforcementReady: false })
    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.indexOf("BEGIN")).toBeGreaterThan(sql.findIndex((statement) => statement.includes("estimated_bytes")))
    expect(sql).toEqual(expect.arrayContaining([expect.stringContaining("progress_cursor"), expect.stringContaining("version=version+1"), "COMMIT"]))
  })
  it("atomically replaces the active plan and returns complete MATCHED evidence", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099", oldId = "00000000-0000-4000-8000-000000000042"
    const nowFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-now-snapshot/v1", ids: [itemId] })).digest("hex")
    const draft = { ...plan, state: "DRAFT", active_workspace_id: null, version: 1, now_snapshot_fingerprint: nowFingerprint, now_snapshot_count: 1 }
    const active = { ...draft, state: "ACTIVE", active_workspace_id: workspaceId, version: 2 }
    const old = { ...plan, id: oldId, state: "ACTIVE", active_workspace_id: workspaceId }
    const staged = { id: "new-r", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: null, units: 1, state: "STAGED", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }
    const activeReservation = { ...staged, active_roadmap_item_id: itemId, state: "ACTIVE" }
    const operationFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-operation/v1", action: "ACTIVATE", semantic: { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, replacesPlanId: oldId } })).digest("hex")
    const responses = [
      { rows: [draft] }, { rows: [] }, { rows: [{ id: "op", action: "ACTIVATE", request_fingerprint: operationFingerprint, status: "IN_PROGRESS", result_json: null }] },
      { rows: [old] }, { rows: [draft] }, { rows: [{ id: itemId }] }, { rows: [staged] }, { rows: [{ reservation_id: "old-r", roadmap_item_id: itemId, plan_id: oldId }] },
      { rows: [{ row_count: "3", estimated_bytes: "512" }] }, { rows: [staged] }, { rows: [{ ...activeReservation, id: "old-r", plan_id: oldId }] },
      { rows: [] }, { rows: [{ id: itemId }] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [] },
      { rows: [active] }, { rows: [{ id: itemId }] }, { rows: [activeReservation] }, { rows: [] }, { rows: [], rowCount: 1 },
    ]
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => responses.shift() ?? { rows: [] })
    const result = await activateCapacityPlan({ query: query as unknown as SqlClient["query"] }, { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, replacesPlanId: oldId, idempotencyKey: "activate-replace" })
    expect(result).toMatchObject({ status: "ACTIVATED_MATCHED", replacesPlanId: oldId, expectedNowItemIds: [itemId], observedNowItemIds: [itemId], missingItemIds: [], extraItemIds: [], invalidReservationIds: [], competingActiveClaims: [], excessItems: 0, excessUnits: 0, runtimeEnforcementReady: false })
    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql.findIndex((statement) => statement.includes("state='RELEASED'"))).toBeLessThan(sql.findIndex((statement) => statement.includes("state='SUPERSEDED'")))
    expect(sql.findIndex((statement) => statement.includes("state='SUPERSEDED'"))).toBeLessThan(sql.findIndex((statement) => statement.includes("active_roadmap_item_id=roadmap_item_id")))
    expect(sql).toContain("COMMIT")
  })
  it("rolls back replacement when activating the new claims fails", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099", oldId = "00000000-0000-4000-8000-000000000042"
    const nowFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-now-snapshot/v1", ids: [itemId] })).digest("hex")
    const draft = { ...plan, state: "DRAFT", active_workspace_id: null, version: 1, now_snapshot_fingerprint: nowFingerprint, now_snapshot_count: 1 }
    const old = { ...plan, id: oldId, state: "ACTIVE", active_workspace_id: workspaceId }
    const staged = { id: "new-r", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: null, units: 1, state: "STAGED", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }
    const operationFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-operation/v1", action: "ACTIVATE", semantic: { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, replacesPlanId: oldId } })).digest("hex")
    const responses = [
      { rows: [draft] }, { rows: [] }, { rows: [{ id: "op", action: "ACTIVATE", request_fingerprint: operationFingerprint, status: "IN_PROGRESS", result_json: null }] },
      { rows: [old] }, { rows: [draft] }, { rows: [{ id: itemId }] }, { rows: [staged] }, { rows: [{ reservation_id: "old-r", roadmap_item_id: itemId, plan_id: oldId }] },
      { rows: [{ row_count: "3", estimated_bytes: "512" }] }, { rows: [staged] }, { rows: [{ ...staged, id: "old-r", plan_id: oldId, active_roadmap_item_id: itemId, state: "ACTIVE" }] },
      { rows: [] }, { rows: [{ id: itemId }] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
    ]
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("active_roadmap_item_id=roadmap_item_id")) throw new Error("injected claim failure")
      return responses.shift() ?? { rows: [] }
    })
    await expect(activateCapacityPlan({ query: query as unknown as SqlClient["query"] }, { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, replacesPlanId: oldId, idempotencyKey: "activate-rollback" })).rejects.toThrow("injected claim failure")
    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql).toContain("ROLLBACK")
    expect(sql).not.toContain("COMMIT")
    expect(sql.filter((statement) => statement.includes("status='SUCCEEDED'"))).toHaveLength(0)
  })
  it("recovers an ambiguous committed activation and reports immediate DRIFTED evidence", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099", extraId = "00000000-0000-4000-8000-000000000098"
    const nowFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-now-snapshot/v1", ids: [itemId] })).digest("hex")
    const active = { ...plan, version: 2, now_snapshot_fingerprint: nowFingerprint, now_snapshot_count: 1 }
    const reservation = { id: "r", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: itemId, units: 1, state: "ACTIVE", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }
    const semantic = { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, replacesPlanId: null }
    const operationFingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-operation/v1", action: "ACTIVATE", semantic })).digest("hex")
    const responses = [
      { rows: [active] }, { rows: [{ id: "op", action: "ACTIVATE", request_fingerprint: operationFingerprint, status: "IN_PROGRESS", result_json: null }] },
      { rows: [active] }, { rows: [{ id: itemId }] }, { rows: [reservation] }, { rows: [] }, { rows: [{ row_count: "2", estimated_bytes: "256" }] },
      { rows: [active] }, { rows: [{ id: itemId }, { id: extraId }] }, { rows: [reservation] }, { rows: [] }, { rows: [], rowCount: 1 },
    ]
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => responses.shift() ?? { rows: [] })
    const result = await activateCapacityPlan({ query: query as unknown as SqlClient["query"] }, { planId, expectedPlanFingerprint: plan.plan_fingerprint, expectedVersion: 1, expectedNowSnapshotFingerprint: nowFingerprint, idempotencyKey: "ambiguous" })
    expect(result).toMatchObject({ status: "ACTIVATED_DRIFTED", expectedNowItemIds: [itemId], observedNowItemIds: [itemId, extraId], extraItemIds: [extraId], runtimeEnforcementReady: false })
    expect(query.mock.calls.map(([statement]) => String(statement))).not.toContain("BEGIN")
  })
  it("allows the explicitly replaced plan claims but still reports third-party claims", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099"
    const replacedId = "00000000-0000-4000-8000-000000000042"
    const thirdId = "00000000-0000-4000-8000-000000000043"
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-now-snapshot/v1", ids: [itemId] })).digest("hex")
    const draft = { ...plan, state: "DRAFT", active_workspace_id: null, now_snapshot_fingerprint: fingerprint, now_snapshot_count: 1 }
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [draft] }).mockResolvedValueOnce({ rows: [{ id: itemId }] })
      .mockResolvedValueOnce({ rows: [{ id: "staged", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: null, units: 1, state: "STAGED", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }] })
      .mockResolvedValueOnce({ rows: [
        { reservation_id: "old", roadmap_item_id: itemId, plan_id: replacedId },
        { reservation_id: "third", roadmap_item_id: itemId, plan_id: thirdId },
      ] })
    const result = await inspectCapacityPlan({ query }, planId, replacedId)
    expect(result.allowedReplacementClaims).toEqual([expect.objectContaining({ plan_id: replacedId })])
    expect(result.competingActiveClaims).toEqual([expect.objectContaining({ plan_id: thirdId })])
    expect(result.activationEligible).toBe(false)
  })
  it("is activation-eligible when all competing claims belong to the explicit replacement", async () => {
    const itemId = "00000000-0000-4000-8000-000000000099", replacedId = "00000000-0000-4000-8000-000000000042"
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: "capacity-now-snapshot/v1", ids: [itemId] })).digest("hex")
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ...plan, state: "DRAFT", active_workspace_id: null, now_snapshot_fingerprint: fingerprint, now_snapshot_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: itemId }] })
      .mockResolvedValueOnce({ rows: [{ id: "staged", plan_id: planId, roadmap_item_id: itemId, active_roadmap_item_id: null, units: 1, state: "STAGED", released_at: null, item_workspace_id: workspaceId, item_horizon: "NOW" }] })
      .mockResolvedValueOnce({ rows: [{ reservation_id: "old", roadmap_item_id: itemId, plan_id: replacedId }] })
    await expect(inspectCapacityPlan({ query }, planId, replacedId)).resolves.toMatchObject({ activationEligible: true, competingActiveClaims: [] })
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
