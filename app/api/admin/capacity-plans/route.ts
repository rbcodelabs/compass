import { NextRequest, NextResponse } from "next/server"
import { withAdminDsqlClient } from "@/lib/admin-dsql-pool"
import {
  CapacityPlanOpsError,
  activateCapacityPlan,
  createCapacityPlan,
  inspectCapacityPlan,
  reconcileCapacityPlan,
} from "@/lib/capacity-plan-ops"
import { inspectConfiguredNowPolicy } from "@/lib/now-eligibility"
import { deploymentNowGateMode } from "@/lib/now-gate-mode"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function authorized(req: NextRequest) {
  const secret = process.env.MIGRATION_SECRET
  return Boolean(secret && req.headers.get("x-migration-secret") === secret)
}

function errorResponse(error: unknown) {
  if (error instanceof CapacityPlanOpsError) {
    const status = error.code === "INVALID_INPUT" ? 400 : error.code === "PLAN_NOT_FOUND" ? 404 : 409
    return NextResponse.json({ error: error.message, code: error.code }, { status })
  }
  return NextResponse.json({ error: "Capacity plan operation failed." }, { status: 500 })
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const planId = req.nextUrl.searchParams.get("planId") ?? ""
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? ""
  try {
    const policy = inspectConfiguredNowPolicy(workspaceId)
    const { inspection, shadowCount, appliedMigrations } = await withAdminDsqlClient(async (db) => {
      const inspection = await inspectCapacityPlan(db, planId)
      let shadowCount = 0
      let appliedMigrations: string[] = []
      const policyEvidenceComplete = policy.runtimePolicyReady
        && typeof policy.policyArtifactId === "string"
        && typeof policy.routingFingerprint === "string"
        && typeof policy.capacityPlanId === "string"
        && typeof policy.capacityPlanFingerprint === "string"
        && typeof policy.generatedAt === "string"
        && Number.isFinite(Date.parse(policy.generatedAt))
      try { shadowCount = policyEvidenceComplete ? Number((await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM now_gate_evaluations WHERE workspace_id=$1 AND outcome='WOULD_ALLOW' AND policy_artifact_id=$2 AND routing_fingerprint=$3 AND capacity_plan_id=$4 AND capacity_plan_fingerprint=$5 AND created_at >= $6", [workspaceId, policy.policyArtifactId, policy.routingFingerprint, policy.capacityPlanId, policy.capacityPlanFingerprint, new Date(policy.generatedAt)])).rows[0]?.count ?? 0) : 0 }
      catch { shadowCount = 0 }
      try { appliedMigrations = (await db.query<{ migration_name: string }>("SELECT DISTINCT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND migration_name = ANY($1::text[])", [["039_native_decision_gates", "042_native_decision_gates_repair", "040_release_authorization", "041_portfolio_capacity_ledger", "043_decision_evidence_refs", "044_now_policy_application_evidence", "045_now_gate_shadow_evaluations"]])).rows.map((row) => row.migration_name) }
      catch { appliedMigrations = [] }
      return { inspection, shadowCount, appliedMigrations }
    })
    if (!workspaceId || inspection.plan.workspace_id !== workspaceId) return NextResponse.json({ error: "Workspace or plan not found." }, { status: 404 })
    const deploymentMode = deploymentNowGateMode()
    const shadowTelemetryReady = shadowCount > 0
    const migrationReady = (appliedMigrations.includes("039_native_decision_gates") || appliedMigrations.includes("042_native_decision_gates_repair"))
      && ["040_release_authorization", "041_portfolio_capacity_ledger", "043_decision_evidence_refs", "044_now_policy_application_evidence", "045_now_gate_shadow_evaluations"].every((name) => appliedMigrations.includes(name))
    const shadowEvaluationReady = policy.runtimePolicyReady && inspection.capacityMetadataReady && shadowTelemetryReady && migrationReady
    return NextResponse.json({
      ...inspection,
      deploymentMode,
      ...policy,
      shadowTelemetryReady,
      migrationReady,
      shadowEvaluationReady,
      runtimeEnforcementReady: deploymentMode === "enforce" && policy.effectiveMode === "enforce" && shadowEvaluationReady,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "An explicit action is required." }, { status: 400 })
  const allowed = body.action === "create"
    ? ["action", "workspaceId", "policyId", "unit", "availableUnits", "unitsPerNowItem", "nowLimit", "idempotencyKey"]
    : body.action === "reconcile"
      ? ["action", "planId", "expectedPlanFingerprint", "expectedVersion", "idempotencyKey"]
      : body.action === "activate"
        ? ["action", "planId", "expectedPlanFingerprint", "expectedVersion", "expectedNowSnapshotFingerprint", "replacesPlanId", "idempotencyKey"]
        : []
  if (allowed.length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) {
    return NextResponse.json({ error: "Unknown action or field." }, { status: 400 })
  }
  try {
    const result = await withAdminDsqlClient(async (db) => {
      if (body.action === "create") return createCapacityPlan(db, body)
      if (body.action === "reconcile") return reconcileCapacityPlan(db, body)
      if (body.action === "activate") return activateCapacityPlan(db, body)
      throw new CapacityPlanOpsError("INVALID_INPUT", "action must be create, reconcile, or activate.")
    })
    return NextResponse.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
