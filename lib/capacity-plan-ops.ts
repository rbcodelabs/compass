import crypto from "node:crypto"

export type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export type CapacityPlanRow = {
  id: string
  workspace_id: string
  policy_id: string
  plan_fingerprint: string
  unit: string
  available_units: number
  units_per_now_item: number
  now_limit: number
  state: string
  active_workspace_id: string | null
  version: number
}

type CapacityStatsRow = {
  active_count: string
  active_units: string
  now_count?: string
  drift_count: string
}

export class CapacityPlanOpsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "CapacityPlanOpsError"
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const MAX_RECONCILE_ROWS = 3_000

function requireUuid(value: string, field: string) {
  if (!UUID.test(value)) throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be a UUID.`)
}

function requireText(value: string, field: string, max: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be 1-${max} characters.`)
  }
}

function requirePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be a positive integer.`)
  }
}

async function findPlan(db: SqlClient, planId: string): Promise<CapacityPlanRow> {
  requireUuid(planId, "planId")
  const { rows } = await db.query<CapacityPlanRow>(
    `SELECT id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
            units_per_now_item, now_limit, state, active_workspace_id, version
     FROM portfolio_capacity_plans WHERE id = $1`,
    [planId],
  )
  if (!rows[0]) throw new CapacityPlanOpsError("PLAN_NOT_FOUND", "Capacity plan not found.")
  return rows[0]
}

function samePlan(plan: CapacityPlanRow, input: CreateCapacityPlanInput) {
  return plan.plan_fingerprint === input.planFingerprint && plan.unit === input.unit &&
    plan.available_units === input.availableUnits && plan.units_per_now_item === input.unitsPerNowItem &&
    plan.now_limit === input.nowLimit
}

export type CreateCapacityPlanInput = {
  workspaceId: string
  policyId: string
  planFingerprint: string
  unit: string
  availableUnits: number
  unitsPerNowItem: number
  nowLimit: number
}

export async function createCapacityPlan(db: SqlClient, input: CreateCapacityPlanInput) {
  requireUuid(input.workspaceId, "workspaceId")
  requireText(input.policyId, "policyId", 160)
  requireText(input.unit, "unit", 80)
  if (!SHA256.test(input.planFingerprint)) throw new CapacityPlanOpsError("INVALID_INPUT", "planFingerprint must be a SHA-256 hex digest.")
  requirePositiveInteger(input.availableUnits, "availableUnits")
  requirePositiveInteger(input.unitsPerNowItem, "unitsPerNowItem")
  requirePositiveInteger(input.nowLimit, "nowLimit")
  const maximumCommittedUnits = input.unitsPerNowItem * input.nowLimit
  if (!Number.isSafeInteger(maximumCommittedUnits) || maximumCommittedUnits > input.availableUnits) {
    throw new CapacityPlanOpsError("INVALID_INPUT", "nowLimit multiplied by unitsPerNowItem exceeds availableUnits.")
  }

  const existing = await db.query<CapacityPlanRow>(
    `SELECT id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
            units_per_now_item, now_limit, state, active_workspace_id, version
     FROM portfolio_capacity_plans WHERE workspace_id = $1 AND policy_id = $2`,
    [input.workspaceId, input.policyId],
  )
  if (existing.rows[0]) {
    if (!samePlan(existing.rows[0], input)) throw new CapacityPlanOpsError("PLAN_CONFLICT", "The policy id already exists with different immutable capacity inputs.")
    return { created: false, plan: existing.rows[0] }
  }

  const id = crypto.randomUUID()
  try {
    const inserted = await db.query<CapacityPlanRow>(
      `INSERT INTO portfolio_capacity_plans
         (id, workspace_id, policy_id, plan_fingerprint, unit, available_units, units_per_now_item, now_limit, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT')
       RETURNING id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
                 units_per_now_item, now_limit, state, active_workspace_id, version`,
      [id, input.workspaceId, input.policyId, input.planFingerprint, input.unit, input.availableUnits, input.unitsPerNowItem, input.nowLimit],
    )
    return { created: true, plan: inserted.rows[0] }
  } catch {
    const raced = await db.query<CapacityPlanRow>(
      `SELECT id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
              units_per_now_item, now_limit, state, active_workspace_id, version
       FROM portfolio_capacity_plans WHERE workspace_id = $1 AND policy_id = $2`,
      [input.workspaceId, input.policyId],
    )
    if (raced.rows[0] && samePlan(raced.rows[0], input)) return { created: false, plan: raced.rows[0] }
    throw new CapacityPlanOpsError("PLAN_CONFLICT", "Capacity plan creation conflicted with another operation.")
  }
}

async function capacityStats(db: SqlClient, plan: CapacityPlanRow) {
  const { rows } = await db.query<CapacityStatsRow>(
    `SELECT
       COUNT(*) FILTER (WHERE r.state = 'ACTIVE')::text AS active_count,
       COALESCE(SUM(r.units) FILTER (WHERE r.state = 'ACTIVE'), 0)::text AS active_units,
       (SELECT COUNT(*)::text FROM roadmap_items i WHERE i.workspace_id = $2 AND i.horizon = 'NOW') AS now_count,
       COUNT(*) FILTER (WHERE r.state = 'ACTIVE' AND (i.id IS NULL OR i.workspace_id <> $2 OR i.horizon <> 'NOW'))::text AS drift_count
     FROM portfolio_capacity_reservations r
     LEFT JOIN roadmap_items i ON i.id = r.roadmap_item_id
     WHERE r.plan_id = $1`,
    [plan.id, plan.workspace_id],
  )
  const row = rows[0] ?? { active_count: "0", active_units: "0", now_count: "0", drift_count: "0" }
  return {
    activeCount: Number(row.active_count),
    activeUnits: Number(row.active_units),
    nowCount: Number(row.now_count ?? 0),
    driftCount: Number(row.drift_count),
  }
}

export async function inspectCapacityPlan(db: SqlClient, planId: string) {
  const plan = await findPlan(db, planId)
  return { plan, ...(await capacityStats(db, plan)) }
}

export async function reconcileCapacityPlan(db: SqlClient, planId: string) {
  const plan = await findPlan(db, planId)
  if (plan.state === "ACTIVE") return { created: 0, released: 0, ...(await capacityStats(db, plan)) }
  if (plan.state !== "DRAFT") throw new CapacityPlanOpsError("PLAN_NOT_DRAFT", "Only a DRAFT capacity plan can be reconciled.")

  const missing = await db.query<{ id: string }>(
    `SELECT i.id FROM roadmap_items i
     LEFT JOIN portfolio_capacity_reservations r ON r.roadmap_item_id = i.id AND r.state = 'ACTIVE'
     WHERE i.workspace_id = $1 AND i.horizon = 'NOW' AND r.id IS NULL
     ORDER BY i.id LIMIT ${MAX_RECONCILE_ROWS + 1}`,
    [plan.workspace_id],
  )
  if (missing.rows.length > MAX_RECONCILE_ROWS) throw new CapacityPlanOpsError("RECONCILE_LIMIT", "More than 3,000 NOW rows require an explicitly chunked reconciliation.")
  const stale = await db.query<{ id: string }>(
    `SELECT r.id FROM portfolio_capacity_reservations r
     LEFT JOIN roadmap_items i ON i.id = r.roadmap_item_id
     WHERE r.plan_id = $1 AND r.state = 'ACTIVE'
       AND (i.id IS NULL OR i.workspace_id <> $2 OR i.horizon <> 'NOW')
     ORDER BY r.id LIMIT ${MAX_RECONCILE_ROWS + 1}`,
    [plan.id, plan.workspace_id],
  )
  if (stale.rows.length > MAX_RECONCILE_ROWS) throw new CapacityPlanOpsError("RECONCILE_LIMIT", "More than 3,000 stale reservations require an explicitly chunked reconciliation.")
  const before = await capacityStats(db, plan)
  const projectedCount = before.activeCount - stale.rows.length + missing.rows.length
  const projectedUnits = before.activeUnits - stale.rows.length * plan.units_per_now_item + missing.rows.length * plan.units_per_now_item
  if (projectedCount > plan.now_limit || projectedUnits > plan.available_units) {
    throw new CapacityPlanOpsError("CAPACITY_EXCEEDED", "Existing NOW commitments exceed this plan's capacity.")
  }

  let released = 0
  for (const row of stale.rows) {
    const result = await db.query(
      `UPDATE portfolio_capacity_reservations SET state = 'RELEASED', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'ACTIVE'`,
      [row.id],
    )
    released += result.rowCount ?? 0
  }
  let created = 0
  for (const row of missing.rows) {
    try {
      const result = await db.query(
        `INSERT INTO portfolio_capacity_reservations
           (id, plan_id, roadmap_item_id, decision_record_id, units, state)
         SELECT $1, $2, $3, NULL, $4, 'ACTIVE'
         WHERE NOT EXISTS (SELECT 1 FROM portfolio_capacity_reservations WHERE roadmap_item_id = $3)`,
        [crypto.randomUUID(), plan.id, row.id, plan.units_per_now_item],
      )
      created += result.rowCount ?? 0
    } catch (error) {
      const raced = await db.query<{ id: string }>(`SELECT id FROM portfolio_capacity_reservations WHERE roadmap_item_id = $1`, [row.id])
      if (!raced.rows[0]) throw error
    }
  }
  return { created, released, ...(await capacityStats(db, plan)) }
}

export type ActivateCapacityPlanInput = { planId: string; expectedVersion: number; planFingerprint: string }

export async function activateCapacityPlan(db: SqlClient, input: ActivateCapacityPlanInput) {
  const plan = await findPlan(db, input.planId)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !SHA256.test(input.planFingerprint)) {
    throw new CapacityPlanOpsError("INVALID_INPUT", "Activation requires a non-negative expectedVersion and SHA-256 planFingerprint.")
  }
  if (plan.plan_fingerprint !== input.planFingerprint) throw new CapacityPlanOpsError("PLAN_CHANGED", "Capacity plan fingerprint does not match the approved input.")
  if (plan.state === "ACTIVE") {
    if (plan.active_workspace_id !== plan.workspace_id) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Active capacity plan is missing its workspace claim.")
    return { activated: false, plan }
  }
  if (plan.state !== "DRAFT") throw new CapacityPlanOpsError("PLAN_NOT_DRAFT", "Only a DRAFT capacity plan can be activated.")
  if (plan.version !== input.expectedVersion) throw new CapacityPlanOpsError("PLAN_CHANGED", "Capacity plan version changed after inspection.")
  const otherActive = await db.query<{ id: string }>(
    `SELECT id FROM portfolio_capacity_plans WHERE workspace_id = $1 AND state = 'ACTIVE' AND id <> $2 LIMIT 1`,
    [plan.workspace_id, plan.id],
  )
  if (otherActive.rows[0]) throw new CapacityPlanOpsError("ACTIVE_PLAN_EXISTS", "Another capacity plan is already active for this workspace.")
  const stats = await capacityStats(db, plan)
  if (stats.nowCount !== stats.activeCount || stats.driftCount !== 0) {
    throw new CapacityPlanOpsError("CAPACITY_DRIFT", "Reconcile every current NOW item before activation.")
  }
  if (stats.activeCount > plan.now_limit || stats.activeUnits > plan.available_units) {
    throw new CapacityPlanOpsError("CAPACITY_EXCEEDED", "Existing NOW commitments exceed this plan's capacity.")
  }
  try {
    const result = await db.query<CapacityPlanRow>(
      `UPDATE portfolio_capacity_plans
       SET state = 'ACTIVE', active_workspace_id = workspace_id,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND workspace_id = $2 AND state = 'DRAFT'
         AND version = $3 AND active_workspace_id IS NULL AND plan_fingerprint = $4
       RETURNING id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
                 units_per_now_item, now_limit, state, active_workspace_id, version`,
      [plan.id, plan.workspace_id, input.expectedVersion, input.planFingerprint],
    )
    if (!result.rows[0]) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Capacity plan activation lost its compare-and-swap claim.")
    return { activated: true, plan: result.rows[0], ...stats }
  } catch (error) {
    if (error instanceof CapacityPlanOpsError) throw error
    const current = await findPlan(db, plan.id)
    if (current.state === "ACTIVE" && current.plan_fingerprint === input.planFingerprint && current.active_workspace_id === current.workspace_id) {
      return { activated: false, plan: current, ...stats }
    }
    const competing = await db.query<{ id: string }>(`SELECT id FROM portfolio_capacity_plans WHERE active_workspace_id = $1 AND id <> $2 LIMIT 1`, [plan.workspace_id, plan.id])
    if (competing.rows[0]) throw new CapacityPlanOpsError("ACTIVE_PLAN_EXISTS", "Another capacity plan won the workspace activation claim.")
    throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Capacity plan activation conflicted with another operation.")
  }
}
