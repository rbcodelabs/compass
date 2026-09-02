import crypto from "node:crypto"

export type SqlClient = { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> }
export type CapacityPlanRow = {
  id: string; workspace_id: string; policy_id: string; plan_fingerprint: string; unit: string
  available_units: number; units_per_now_item: number; now_limit: number; state: string
  active_workspace_id: string | null; now_snapshot_fingerprint: string | null
  now_snapshot_count: number | null; reconciled_at: string | null; version: number
}
type OperationRow = { id: string; action: string; request_fingerprint: string; status: string; result_json: string | null }
type ReservationRow = {
  id: string; plan_id: string; roadmap_item_id: string; active_roadmap_item_id: string | null
  units: number; state: string; released_at: string | null; item_workspace_id: string | null; item_horizon: string | null
}
export class CapacityPlanOpsError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CapacityPlanOpsError" }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{64}$/i
const MAX_ROWS = 2_900
const MAX_BYTES = 9 * 1024 * 1024
const MAX_INT32 = 2_147_483_647
const CONSERVATIVE_WRITE_BYTES = 2_048
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
const snapshot = (ids: string[]) => digest({ schemaVersion: "capacity-now-snapshot/v1", ids: [...ids].sort() })
function uuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be a UUID.`)
}
function textValue(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be 1-${max} characters.`)
}
function positive(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > MAX_INT32) throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be a positive int32.`)
}
function version(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_INT32) throw new CapacityPlanOpsError("INVALID_INPUT", `${field} must be a non-negative int32.`)
}
const uniqueConflict = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505"
function safeEstimate(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null
  if (typeof value === "string" && !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
export function capacityOperationPreflight(row: { row_count?: unknown; estimated_bytes?: unknown } | undefined) {
  const rowCount = safeEstimate(row?.row_count), estimatedBytes = safeEstimate(row?.estimated_bytes)
  return { available: rowCount !== null && estimatedBytes !== null, rowCount, estimatedBytes,
    passed: rowCount !== null && estimatedBytes !== null && rowCount <= MAX_ROWS && estimatedBytes <= MAX_BYTES,
    limits: { maxRows: MAX_ROWS, maxBytes: MAX_BYTES } }
}
async function assertOperationFits(db: SqlClient, workspaceId: string, planIds: string[], plannedWrites = 0) {
  const result = await db.query<{ row_count: unknown; estimated_bytes: unknown }>(
    `SELECT COUNT(*)::bigint row_count, COALESCE(SUM(estimated_bytes),0)::bigint estimated_bytes FROM (
       SELECT pg_column_size(r)::bigint estimated_bytes FROM portfolio_capacity_reservations r WHERE r.plan_id = ANY($1::uuid[])
       UNION ALL
       SELECT pg_column_size(i)::bigint estimated_bytes FROM roadmap_items i WHERE i.workspace_id=$2 AND i.horizon='NOW'
     ) operation_rows`, [planIds, workspaceId])
  const base = result.rows[0]
  const rowCount = safeEstimate(base?.row_count), estimatedBytes = safeEstimate(base?.estimated_bytes)
  const check = capacityOperationPreflight(rowCount === null || estimatedBytes === null ? undefined : {
    row_count: rowCount + plannedWrites,
    estimated_bytes: estimatedBytes + plannedWrites * CONSERVATIVE_WRITE_BYTES,
  })
  if (!check.passed) throw new CapacityPlanOpsError("CAPACITY_OPERATION_LIMIT", "Capacity operation row/byte estimate is unavailable, malformed, or unsafe.")
  return check
}
async function planById(db: SqlClient, id: string) {
  uuid(id, "planId")
  const row = (await db.query<CapacityPlanRow>(
    `SELECT id, workspace_id, policy_id, plan_fingerprint, unit, available_units, units_per_now_item,
      now_limit, state, active_workspace_id, now_snapshot_fingerprint, now_snapshot_count, reconciled_at, version
      FROM portfolio_capacity_plans WHERE id=$1`, [id])).rows[0]
  if (!row) throw new CapacityPlanOpsError("PLAN_NOT_FOUND", "Capacity plan not found.")
  return row
}
async function nowIds(db: SqlClient, workspaceId: string) {
  const rows = (await db.query<{ id: string }>(
    `SELECT id FROM roadmap_items WHERE workspace_id=$1 AND horizon='NOW' ORDER BY id LIMIT ${MAX_ROWS + 1}`, [workspaceId])).rows
  if (rows.length > MAX_ROWS) throw new CapacityPlanOpsError("CAPACITY_OPERATION_LIMIT", "NOW set exceeds bounded precursor operation limit.")
  return rows.map((row) => row.id)
}
async function reservations(db: SqlClient, planId: string) {
  return (await db.query<ReservationRow>(
    `SELECT r.id,r.plan_id,r.roadmap_item_id,r.active_roadmap_item_id,r.units,r.state,r.released_at,
      i.workspace_id item_workspace_id,i.horizon item_horizon
      FROM portfolio_capacity_reservations r LEFT JOIN roadmap_items i ON i.id=r.roadmap_item_id
      WHERE r.plan_id=$1 ORDER BY r.roadmap_item_id`, [planId])).rows
}
async function operation(db: SqlClient, workspaceId: string, key: string) {
  return (await db.query<OperationRow>(
    `SELECT id,action,request_fingerprint,status,result_json FROM portfolio_capacity_operations
      WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, key])).rows[0]
}
async function beginOperation(db: SqlClient, input: { workspaceId: string; planId?: string; action: string; key: string; semantic: unknown }) {
  textValue(input.key, "idempotencyKey", 160)
  const fingerprint = digest({ schemaVersion: "capacity-operation/v1", action: input.action, semantic: input.semantic })
  let found = await operation(db, input.workspaceId, input.key)
  if (!found) {
    try {
      found = (await db.query<OperationRow>(
        `INSERT INTO portfolio_capacity_operations
          (id,workspace_id,plan_id,action,idempotency_key,request_fingerprint,status)
          VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS')
          RETURNING id,action,request_fingerprint,status,result_json`,
        [crypto.randomUUID(), input.workspaceId, input.planId ?? null, input.action, input.key, fingerprint])).rows[0]
    } catch (error) {
      if (!uniqueConflict(error)) throw error
      found = await operation(db, input.workspaceId, input.key)
    }
  }
  if (!found || found.action !== input.action || found.request_fingerprint !== fingerprint) throw new CapacityPlanOpsError("IDEMPOTENCY_CONFLICT", "Idempotency key payload differs.")
  if (found.status === "FAILED_FINAL") throw new CapacityPlanOpsError("OPERATION_FAILED_FINAL", "Operation is terminally failed.")
  return { row: found, stored: found.status === "SUCCEEDED" && found.result_json ? JSON.parse(found.result_json) as unknown : undefined }
}
async function complete(db: SqlClient, id: string, result: unknown) {
  await db.query(`UPDATE portfolio_capacity_operations SET status='SUCCEEDED',result_json=$2,error_code=NULL,
    updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=$1`, [id, JSON.stringify(result)])
}
async function failed(db: SqlClient, id: string, code: string, retryable: boolean) {
  await db.query(`UPDATE portfolio_capacity_operations SET status=$2,error_code=$3,updated_at=CURRENT_TIMESTAMP,
    completed_at=CASE WHEN $2='FAILED_FINAL' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=$1`,
  [id, retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL", code])
}

export type CreateCapacityPlanInput = {
  workspaceId: string; policyId: string; unit: "FOCUS_SLOT"; availableUnits: number
  unitsPerNowItem: 1; nowLimit: number; idempotencyKey: string
}
export async function createCapacityPlan(db: SqlClient, input: CreateCapacityPlanInput) {
  uuid(input.workspaceId, "workspaceId"); textValue(input.policyId, "policyId", 160)
  if (input.unit !== "FOCUS_SLOT" || input.unitsPerNowItem !== 1) throw new CapacityPlanOpsError("INVALID_INPUT", "v1 requires FOCUS_SLOT and one unit per NOW item.")
  positive(input.availableUnits, "availableUnits"); positive(input.nowLimit, "nowLimit")
  if (input.nowLimit > input.availableUnits) throw new CapacityPlanOpsError("INVALID_INPUT", "nowLimit exceeds availableUnits.")
  if (!(await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE id=$1`, [input.workspaceId])).rows[0]) throw new CapacityPlanOpsError("WORKSPACE_NOT_FOUND", "Workspace not found.")
  const semantic = { workspaceId: input.workspaceId, policyId: input.policyId, unit: input.unit, availableUnits: input.availableUnits, unitsPerNowItem: 1, nowLimit: input.nowLimit }
  const receipt = await beginOperation(db, { workspaceId: input.workspaceId, action: "CREATE", key: input.idempotencyKey, semantic })
  if (receipt.stored) return receipt.stored
  const planFingerprint = digest({ schemaVersion: "capacity-plan/v1", ...semantic })
  const existing = (await db.query<CapacityPlanRow>(`SELECT * FROM portfolio_capacity_plans WHERE workspace_id=$1 AND policy_id=$2`, [input.workspaceId, input.policyId])).rows[0]
  if (existing && existing.plan_fingerprint !== planFingerprint) {
    await failed(db, receipt.row.id, "IDEMPOTENCY_CONFLICT", false)
    throw new CapacityPlanOpsError("IDEMPOTENCY_CONFLICT", "Policy identity has different semantic inputs.")
  }
  const created = !existing
  let plan = existing
  if (!plan) {
    try {
      plan = (await db.query<CapacityPlanRow>(
        `INSERT INTO portfolio_capacity_plans
          (id,workspace_id,policy_id,plan_fingerprint,unit,available_units,units_per_now_item,now_limit,state)
          VALUES ($1,$2,$3,$4,'FOCUS_SLOT',$5,1,$6,'DRAFT') RETURNING *`,
        [crypto.randomUUID(), input.workspaceId, input.policyId, planFingerprint, input.availableUnits, input.nowLimit])).rows[0]
    } catch (error) {
      if (!uniqueConflict(error)) throw error
      plan = (await db.query<CapacityPlanRow>(`SELECT * FROM portfolio_capacity_plans WHERE workspace_id=$1 AND policy_id=$2`, [input.workspaceId, input.policyId])).rows[0]
      if (!plan || plan.plan_fingerprint !== planFingerprint) {
        await failed(db, receipt.row.id, "IDEMPOTENCY_CONFLICT", false)
        throw new CapacityPlanOpsError("IDEMPOTENCY_CONFLICT", "Concurrent policy identity has different semantic inputs.")
      }
    }
  }
  const result = { action: "CREATE", created, plan, operationId: receipt.row.id, runtimeEnforcementReady: false }
  await complete(db, receipt.row.id, result)
  return result
}

export async function inspectCapacityPlan(db: SqlClient, planId: string, allowedReplacesPlanId?: string) {
  if (allowedReplacesPlanId) uuid(allowedReplacesPlanId, "allowedReplacesPlanId")
  const plan = await planById(db, planId)
  const [liveIds, rows, competing] = await Promise.all([
    nowIds(db, plan.workspace_id), reservations(db, plan.id),
    db.query<{ reservation_id: string; roadmap_item_id: string; plan_id: string }>(
      `SELECT id reservation_id,roadmap_item_id,plan_id FROM portfolio_capacity_reservations
        WHERE active_roadmap_item_id IS NOT NULL AND plan_id<>$1 ORDER BY roadmap_item_id`, [plan.id]),
  ])
  const live = new Set(liveIds)
  const current = rows.filter((r) => r.state === "STAGED" || r.state === "ACTIVE")
  const covered = new Set(current.map((r) => r.roadmap_item_id))
  const missingItemIds = liveIds.filter((id) => !covered.has(id))
  const staleReservationIds = current.filter((r) => r.item_workspace_id !== plan.workspace_id || r.item_horizon !== "NOW").map((r) => r.id)
  const invalidReservationIds = rows.filter((r) => !(
    (r.state === "STAGED" && r.active_roadmap_item_id === null && r.released_at === null) ||
    (r.state === "ACTIVE" && r.active_roadmap_item_id === r.roadmap_item_id && r.released_at === null) ||
    (r.state === "RELEASED" && r.active_roadmap_item_id === null && r.released_at !== null)
  )).map((r) => r.id)
  const relevant = current.filter((r) => live.has(r.roadmap_item_id))
  const reservedUnits = relevant.reduce((sum, row) => sum + row.units, 0)
  const excessItems = Math.max(0, relevant.length - plan.now_limit), excessUnits = Math.max(0, reservedUnits - plan.available_units)
  const liveFingerprint = snapshot(liveIds)
  const snapshotMatches = plan.now_snapshot_fingerprint === liveFingerprint && plan.now_snapshot_count === liveIds.length
  const activeClaims = competing.rows.filter((r) => live.has(r.roadmap_item_id))
  const allowedReplacementClaims = activeClaims.filter((r) => r.plan_id === allowedReplacesPlanId)
  const competingActiveClaims = activeClaims.filter((r) => r.plan_id !== allowedReplacesPlanId)
  const clean = missingItemIds.length === 0 && staleReservationIds.length === 0 && invalidReservationIds.length === 0 && competingActiveClaims.length === 0 && excessItems === 0 && excessUnits === 0
  return {
    plan, currentNowItemIds: liveIds,
    reservations: rows.map((r) => ({ id: r.id, planId: r.plan_id, roadmapItemId: r.roadmap_item_id, activeRoadmapItemId: r.active_roadmap_item_id, state: r.state, units: r.units })),
    missingItemIds, staleReservationIds, invalidReservationIds, allowedReplacementClaims, competingActiveClaims, reservedUnits, excessItems, excessUnits,
    liveNowSnapshotFingerprint: liveFingerprint, storedNowSnapshotFingerprint: plan.now_snapshot_fingerprint,
    snapshotMatches, observedAt: new Date().toISOString(), activationEligible: plan.state === "DRAFT" && snapshotMatches && clean,
    capacityMetadataReady: plan.state === "ACTIVE" && snapshotMatches && clean, runtimeEnforcementReady: false,
  }
}

export type ReconcileCapacityPlanInput = { planId: string; expectedPlanFingerprint: string; expectedVersion: number; idempotencyKey: string }
export async function reconcileCapacityPlan(db: SqlClient, input: ReconcileCapacityPlanInput) {
  version(input.expectedVersion, "expectedVersion")
  const plan = await planById(db, input.planId)
  const semantic = { planId: plan.id, expectedPlanFingerprint: input.expectedPlanFingerprint, expectedVersion: input.expectedVersion }
  const receipt = await beginOperation(db, { workspaceId: plan.workspace_id, planId: plan.id, action: "RECONCILE", key: input.idempotencyKey, semantic })
  if (receipt.stored) return receipt.stored
  if (!SHA.test(input.expectedPlanFingerprint) || plan.plan_fingerprint !== input.expectedPlanFingerprint || plan.version !== input.expectedVersion) {
    await failed(db, receipt.row.id, "PLAN_CHANGED", false)
    throw new CapacityPlanOpsError("PLAN_CHANGED", "Plan changed after inspection.")
  }
  if (plan.state !== "DRAFT") {
    await failed(db, receipt.row.id, "PLAN_NOT_DRAFT", false)
    throw new CapacityPlanOpsError("PLAN_NOT_DRAFT", "Only DRAFT plans reconcile.")
  }
  try {
    const ids = await nowIds(db, plan.workspace_id)
    if (ids.length > plan.now_limit || ids.length > plan.available_units) throw new CapacityPlanOpsError("CAPACITY_EXCEEDED", "NOW exceeds capacity.")
    const old = await reservations(db, plan.id), wanted = new Set(ids)
    const deletes = old.filter((row) => row.state === "STAGED" && !wanted.has(row.roadmap_item_id)).length
    const existingIds = new Set(old.filter((row) => row.state === "STAGED" && wanted.has(row.roadmap_item_id)).map((row) => row.roadmap_item_id))
    const inserts = ids.filter((id) => !existingIds.has(id)).length
    await assertOperationFits(db, plan.workspace_id, [plan.id], deletes + inserts * 2 + 1)
    await db.query("BEGIN")
    for (const row of old) {
      if (row.state === "STAGED" && !wanted.has(row.roadmap_item_id)) await db.query(`DELETE FROM portfolio_capacity_reservations WHERE id=$1 AND state='STAGED'`, [row.id])
      else if (row.state !== "STAGED" || row.active_roadmap_item_id !== null) throw new CapacityPlanOpsError("RESERVATION_CONFLICT", "Draft has non-staged history.")
    }
    const present = new Set(old.filter((r) => r.state === "STAGED" && wanted.has(r.roadmap_item_id)).map((r) => r.roadmap_item_id))
    for (const itemId of ids) if (!present.has(itemId)) {
      await db.query(`INSERT INTO portfolio_capacity_reservations
        (id,plan_id,roadmap_item_id,active_roadmap_item_id,decision_record_id,units,state)
        VALUES ($1,$2,$3,NULL,NULL,1,'STAGED')`, [crypto.randomUUID(), plan.id, itemId])
      await db.query(`UPDATE portfolio_capacity_operations SET progress_cursor=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [receipt.row.id, itemId])
    }
    const exact = await nowIds(db, plan.workspace_id)
    const staged = (await reservations(db, plan.id)).filter((r) => r.state === "STAGED").map((r) => r.roadmap_item_id).sort()
    if (JSON.stringify(exact) !== JSON.stringify(staged)) throw new CapacityPlanOpsError("NOW_SNAPSHOT_CHANGED", "NOW changed during reconciliation.")
    const fp = snapshot(exact)
    const updated = (await db.query<CapacityPlanRow>(`UPDATE portfolio_capacity_plans SET
      now_snapshot_fingerprint=$3,now_snapshot_count=$4,reconciled_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND state='DRAFT' AND version=$2 AND plan_fingerprint=$5 RETURNING *`,
      [plan.id, input.expectedVersion, fp, exact.length, input.expectedPlanFingerprint])).rows[0]
    if (!updated) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Reconciliation lost version CAS.")
    const result = { action: "RECONCILE", plan: updated, stagedItemIds: staged, nowSnapshotFingerprint: fp, nowSnapshotCount: exact.length, operationId: receipt.row.id, runtimeEnforcementReady: false }
    await complete(db, receipt.row.id, result); await db.query("COMMIT"); return result
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    const code = error instanceof CapacityPlanOpsError ? error.code : "DATABASE_RETRY"
    await failed(db, receipt.row.id, code, !(error instanceof CapacityPlanOpsError)); throw error
  }
}

export type ActivateCapacityPlanInput = {
  planId: string; expectedPlanFingerprint: string; expectedVersion: number
  expectedNowSnapshotFingerprint: string; replacesPlanId?: string; idempotencyKey: string
}
export async function activateCapacityPlan(db: SqlClient, input: ActivateCapacityPlanInput) {
  version(input.expectedVersion, "expectedVersion")
  const plan = await planById(db, input.planId)
  const semantic = { planId: plan.id, expectedPlanFingerprint: input.expectedPlanFingerprint, expectedVersion: input.expectedVersion, expectedNowSnapshotFingerprint: input.expectedNowSnapshotFingerprint, replacesPlanId: input.replacesPlanId ?? null }
  const receipt = await beginOperation(db, { workspaceId: plan.workspace_id, planId: plan.id, action: "ACTIVATE", key: input.idempotencyKey, semantic })
  if (receipt.stored) return receipt.stored
  const recoveredActivation = plan.state === "ACTIVE" && plan.active_workspace_id === plan.workspace_id && plan.version === input.expectedVersion + 1
  if (!SHA.test(input.expectedPlanFingerprint) || !SHA.test(input.expectedNowSnapshotFingerprint) || plan.plan_fingerprint !== input.expectedPlanFingerprint || plan.now_snapshot_fingerprint !== input.expectedNowSnapshotFingerprint || (!recoveredActivation && plan.version !== input.expectedVersion)) {
    await failed(db, receipt.row.id, "PLAN_CHANGED", false)
    throw new CapacityPlanOpsError("PLAN_CHANGED", "Activation inputs differ from reconciled plan.")
  }
  const replaced = input.replacesPlanId && !recoveredActivation ? await planById(db, input.replacesPlanId) : null
  if (replaced && (replaced.workspace_id !== plan.workspace_id || replaced.state !== "ACTIVE")) {
    await failed(db, receipt.row.id, "REPLACEMENT_MISMATCH", false)
    throw new CapacityPlanOpsError("REPLACEMENT_MISMATCH", "Replacement is not active in this workspace.")
  }
  const pre = await inspectCapacityPlan(db, plan.id, replaced?.id)
  if (plan.state !== "ACTIVE" && (!pre.activationEligible || pre.liveNowSnapshotFingerprint !== input.expectedNowSnapshotFingerprint)) {
    await failed(db, receipt.row.id, "ACTIVATION_PRECHECK_FAILED", false)
    throw new CapacityPlanOpsError("ACTIVATION_PRECHECK_FAILED", "Fresh inspection differs from reconciled snapshot.")
  }
  await assertOperationFits(db, plan.workspace_id, replaced ? [plan.id, replaced.id] : [plan.id])
  if (plan.state !== "ACTIVE") {
    const nextRows = await reservations(db, plan.id), oldRows = replaced ? await reservations(db, replaced.id) : []
    if (nextRows.length + oldRows.filter((r) => r.state === "ACTIVE").length + 3 > MAX_ROWS) throw new CapacityPlanOpsError("CAPACITY_OPERATION_LIMIT", "Replacement exceeds bounded transaction.")
    try {
      await db.query("BEGIN")
      if (snapshot(await nowIds(db, plan.workspace_id)) !== input.expectedNowSnapshotFingerprint) throw new CapacityPlanOpsError("NOW_SNAPSHOT_CHANGED", "NOW changed before commit.")
      if (replaced) {
        const released = await db.query(`UPDATE portfolio_capacity_reservations SET state='RELEASED',active_roadmap_item_id=NULL,released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE plan_id=$1 AND state='ACTIVE'`, [replaced.id])
        if ((released.rowCount ?? 0) !== oldRows.filter((r) => r.state === "ACTIVE").length) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Old claims changed.")
        const oldPlan = await db.query(`UPDATE portfolio_capacity_plans SET state='SUPERSEDED',active_workspace_id=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND workspace_id=$2 AND state='ACTIVE' AND active_workspace_id=workspace_id`, [replaced.id, plan.workspace_id])
        if (oldPlan.rowCount !== 1) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Old plan changed.")
      }
      const claims = await db.query(`UPDATE portfolio_capacity_reservations SET state='ACTIVE',active_roadmap_item_id=roadmap_item_id,updated_at=CURRENT_TIMESTAMP WHERE plan_id=$1 AND state='STAGED' AND active_roadmap_item_id IS NULL`, [plan.id])
      if ((claims.rowCount ?? 0) !== pre.currentNowItemIds.length) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Staged claims changed.")
      const activated = await db.query(`UPDATE portfolio_capacity_plans SET state='ACTIVE',active_workspace_id=workspace_id,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND workspace_id=$2 AND state='DRAFT' AND version=$3 AND plan_fingerprint=$4 AND now_snapshot_fingerprint=$5 AND active_workspace_id IS NULL`, [plan.id, plan.workspace_id, input.expectedVersion, input.expectedPlanFingerprint, input.expectedNowSnapshotFingerprint])
      if (activated.rowCount !== 1) throw new CapacityPlanOpsError("CAPACITY_CONFLICT", "Activation lost version CAS.")
      await db.query("COMMIT")
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined)
      const code = uniqueConflict(error) ? "ACTIVE_PLAN_EXISTS" : error instanceof CapacityPlanOpsError ? error.code : "DATABASE_RETRY"
      await failed(db, receipt.row.id, code, !uniqueConflict(error) && !(error instanceof CapacityPlanOpsError))
      if (uniqueConflict(error)) throw new CapacityPlanOpsError("ACTIVE_PLAN_EXISTS", "Another active claim won."); throw error
    }
  }
  const post = await inspectCapacityPlan(db, plan.id)
  const matched = post.snapshotMatches && !post.missingItemIds.length && !post.staleReservationIds.length && !post.invalidReservationIds.length && !post.competingActiveClaims.length && post.excessItems === 0 && post.excessUnits === 0
  const status = matched ? "ACTIVATED_MATCHED" : "ACTIVATED_DRIFTED"
  const expectedIds = new Set(pre.currentNowItemIds), observedIds = new Set(post.currentNowItemIds)
  const result = { action: "ACTIVATE", status, planId: plan.id, replacesPlanId: replaced?.id ?? input.replacesPlanId ?? null, observedAt: post.observedAt, expectedNowSnapshotFingerprint: input.expectedNowSnapshotFingerprint, observedNowSnapshotFingerprint: post.liveNowSnapshotFingerprint, expectedNowItemIds: pre.currentNowItemIds, observedNowItemIds: post.currentNowItemIds, missingItemIds: pre.currentNowItemIds.filter((id) => !observedIds.has(id)), extraItemIds: post.currentNowItemIds.filter((id) => !expectedIds.has(id)), staleReservationIds: post.staleReservationIds, invalidReservationIds: post.invalidReservationIds, competingActiveClaims: post.competingActiveClaims, reservedUnits: post.reservedUnits, excessItems: post.excessItems, excessUnits: post.excessUnits, runtimeEnforcementReady: false }
  await complete(db, receipt.row.id, result); return result
}
