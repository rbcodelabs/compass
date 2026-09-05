import { NextRequest, NextResponse } from "next/server"
import { withAdminDsqlClient } from "@/lib/admin-dsql-pool"
import { runSharedCommentsBackfill, type SharedCommentsBackfillOperation } from "@/lib/shared-comments-backfill"

export const maxDuration = 60

function authorized(req: NextRequest) {
  const secret = process.env.MIGRATION_SECRET
  return Boolean(secret) && req.headers.get("x-migration-secret") === secret
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { operation?: unknown; batchSize?: unknown }
  if (body.operation !== "backfill" && body.operation !== "validate") {
    return NextResponse.json({ error: "operation must be backfill or validate" }, { status: 400 })
  }
  const batchSize = body.batchSize ?? 500
  if (!Number.isInteger(batchSize) || Number(batchSize) < 1 || Number(batchSize) > 500) {
    return NextResponse.json({ error: "batchSize must be an integer from 1 to 500" }, { status: 400 })
  }
  const result = await withAdminDsqlClient((client) => runSharedCommentsBackfill(client, {
    operation: body.operation as SharedCommentsBackfillOperation,
    batchSize: Number(batchSize),
  }))
  const inserted = result.processed ? Object.values(result.processed).reduce((sum, value) => sum + value, 0) : 0
  const blocked = !result.invariants.passed && (
    body.operation === "validate" ||
    result.invariants.orphanedDocComments > 0 ||
    result.invariants.orphanedSolutionComments > 0 ||
    inserted === 0
  )
  return NextResponse.json(result, { status: blocked ? 409 : 200 })
}
