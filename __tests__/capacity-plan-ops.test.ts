import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CapacityPlanOpsError,
  activateCapacityPlan,
  createCapacityPlan,
  inspectCapacityPlan,
  reconcileCapacityPlan,
} from "@/lib/capacity-plan-ops"

const query = vi.fn()
const db = { query }
const plan = {
  id: "00000000-0000-4000-8000-000000000041",
  workspace_id: "00000000-0000-4000-8000-000000000001",
  policy_id: "obsidian:capacity:v1",
  plan_fingerprint: "a".repeat(64),
  unit: "engineer-week",
  available_units: 6,
  units_per_now_item: 2,
  now_limit: 3,
  state: "DRAFT",
  active_workspace_id: null,
  version: 0,
}

beforeEach(() => vi.resetAllMocks())

describe("capacity plan operator operations", () => {
  it("returns an identical existing plan without writing", async () => {
    query.mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
    await expect(createCapacityPlan(db, {
      workspaceId: plan.workspace_id,
      policyId: plan.policy_id,
      planFingerprint: plan.plan_fingerprint,
      unit: plan.unit,
      availableUnits: 6,
      unitsPerNowItem: 2,
      nowLimit: 3,
    })).resolves.toMatchObject({ created: false, plan })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("rejects reuse of a policy id with different immutable inputs", async () => {
    query.mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
    await expect(createCapacityPlan(db, {
      workspaceId: plan.workspace_id,
      policyId: plan.policy_id,
      planFingerprint: "b".repeat(64),
      unit: plan.unit,
      availableUnits: 6,
      unitsPerNowItem: 2,
      nowLimit: 3,
    })).rejects.toMatchObject({ code: "PLAN_CONFLICT" })
  })

  it("reconcile is idempotent and only reserves currently unreserved NOW items", async () => {
    query
      .mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "item-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ active_count: "0", active_units: "0", now_count: "1", drift_count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ active_count: "1", active_units: "2", drift_count: "0" }], rowCount: 1 })
    await expect(reconcileCapacityPlan(db, plan.id)).resolves.toMatchObject({ created: 1, activeCount: 1 })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO portfolio_capacity_reservations"))).toBe(true)
  })

  it("activation fails closed on drift or capacity excess and remains separate from reconcile", async () => {
    query
      .mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ active_count: "2", active_units: "4", now_count: "3", drift_count: "0" }], rowCount: 1 })
    await expect(activateCapacityPlan(db, { planId: plan.id, expectedVersion: 0, planFingerprint: plan.plan_fingerprint })).rejects.toMatchObject({ code: "CAPACITY_DRIFT" })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET state = 'ACTIVE'"))).toBe(false)
  })

  it("activation is idempotent after a plan is already active", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...plan, state: "ACTIVE", active_workspace_id: plan.workspace_id }], rowCount: 1 })
    await expect(activateCapacityPlan(db, { planId: plan.id, expectedVersion: 0, planFingerprint: plan.plan_fingerprint })).resolves.toMatchObject({ activated: false })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("refuses to activate a second plan for the same workspace", async () => {
    query
      .mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "other-plan" }], rowCount: 1 })
    await expect(activateCapacityPlan(db, { planId: plan.id, expectedVersion: 0, planFingerprint: plan.plan_fingerprint })).rejects.toMatchObject({ code: "ACTIVE_PLAN_EXISTS" })
  })

  it("rejects stale activation inputs before claiming workspace authority", async () => {
    query.mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
    await expect(activateCapacityPlan(db, { planId: plan.id, expectedVersion: 1, planFingerprint: plan.plan_fingerprint })).rejects.toMatchObject({ code: "PLAN_CHANGED" })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("inspect reports the plan, reservations, NOW count, and drift without mutation", async () => {
    query
      .mockResolvedValueOnce({ rows: [plan], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ active_count: "1", active_units: "2", now_count: "1", drift_count: "0" }], rowCount: 1 })
    await expect(inspectCapacityPlan(db, plan.id)).resolves.toMatchObject({ plan, activeCount: 1, nowCount: 1, driftCount: 0 })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("validates fingerprints and positive integral capacity before querying", async () => {
    await expect(createCapacityPlan(db, {
      workspaceId: plan.workspace_id,
      policyId: plan.policy_id,
      planFingerprint: "bad",
      unit: plan.unit,
      availableUnits: 0,
      unitsPerNowItem: 2,
      nowLimit: 3,
    })).rejects.toBeInstanceOf(CapacityPlanOpsError)
    expect(query).not.toHaveBeenCalled()
  })
})
