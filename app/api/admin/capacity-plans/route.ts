import { NextRequest, NextResponse } from "next/server"
import { withAdminDsqlClient } from "@/lib/admin-dsql-pool"
import {
  CapacityPlanOpsError,
  activateCapacityPlan,
  createCapacityPlan,
  inspectCapacityPlan,
  reconcileCapacityPlan,
} from "@/lib/capacity-plan-ops"

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
  try {
    return NextResponse.json(await withAdminDsqlClient((db) => inspectCapacityPlan(db, planId)))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "An explicit action is required." }, { status: 400 })
  try {
    const result = await withAdminDsqlClient(async (db) => {
      if (body.action === "create") return createCapacityPlan(db, body)
      if (body.action === "reconcile") return reconcileCapacityPlan(db, body.planId ?? "")
      if (body.action === "activate") return activateCapacityPlan(db, {
        planId: body.planId ?? "",
        expectedVersion: body.expectedVersion,
        planFingerprint: body.planFingerprint,
      })
      throw new CapacityPlanOpsError("INVALID_INPUT", "action must be create, reconcile, or activate.")
    })
    return NextResponse.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
