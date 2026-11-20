import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import type { Pool } from "pg"
import { createInspectionPool, type InspectionPoolFactory } from "@/lib/migrations/inspection-pool"
import manifestJson from "./048-legacy-decision-review-repair-manifest.json"
import {
  parseLegacyDecisionRepairManifest,
  repairLegacyDecisionRequests,
  type LegacyDecisionRepairClient,
  type LegacyDecisionRepairManifest,
  type LegacyDecisionRepairPlan,
} from "@/lib/legacy-decision-repair"

export const LEGACY_DECISION_REVIEW_REPAIR_MIGRATION = "048_legacy_decision_review_repair"

const productionManifest = parseLegacyDecisionRepairManifest(manifestJson)

export type LegacyDecisionReviewRepairReport = {
  workspaceId: string
  workspaceStatus: "PRESENT" | "NOT_PRESENT"
  mode: "DRY_RUN" | "APPLY"
  requests: Array<Pick<LegacyDecisionRepairPlan, "requestId" | "status" | "code" | "message" | "sourceRevisionId" | "newRevisionNumber" | "fingerprint" | "summary" | "packet">>
}

function createClient(pool: Pool, schema: string) {
  const adapter = new PrismaPg(pool, { schema, disposeExternalPool: false })
  return new PrismaClient({ adapter })
}

function summarize(
  report: Awaited<ReturnType<typeof repairLegacyDecisionRequests>>,
  workspaceStatus: "PRESENT" | "NOT_PRESENT",
): LegacyDecisionReviewRepairReport {
  return {
    workspaceId: report.workspaceId,
    workspaceStatus,
    mode: report.mode,
    requests: report.requests.map(({ requestId, status, code, message, sourceRevisionId, newRevisionNumber, fingerprint, summary, packet }) => ({
      requestId,
      status,
      code,
      message,
      sourceRevisionId,
      newRevisionNumber,
      fingerprint,
      summary,
      packet,
    })),
  }
}

async function run(
  pool: Pool,
  schema: string,
  apply: boolean,
  manifestOverride?: LegacyDecisionRepairManifest,
  boundedInspection = false,
  inspectionPoolFactory?: InspectionPoolFactory,
): Promise<LegacyDecisionReviewRepairReport> {
  const manifest = parseLegacyDecisionRepairManifest(manifestOverride ?? productionManifest)
  // Status already holds a caller-pool connection. A separate, bounded pool prevents a max=1 caller from waiting on itself.
  const inspectionPool = boundedInspection ? await (inspectionPoolFactory?.() ?? createInspectionPool(pool.options ?? {})) : undefined
  let prisma: PrismaClient | undefined
  try {
    prisma = createClient(inspectionPool ?? pool, schema)
    const execute = async (db: LegacyDecisionRepairClient): Promise<LegacyDecisionReviewRepairReport> => {
      // Missing tables are migration-system errors. Only a genuine absent target
      // workspace is a safe no-op in dev/preview schemas.
      const workspace = await db.workspace.findUnique({ where: { id: manifest.workspaceId }, select: { id: true } })
      if (!workspace) {
        return { workspaceId: manifest.workspaceId, workspaceStatus: "NOT_PRESENT", mode: apply ? "APPLY" : "DRY_RUN", requests: [] }
      }

      const report = await repairLegacyDecisionRequests(
        db,
        manifest,
        { apply },
      )
      return summarize(report, "PRESENT")
    }
    // Dry-run performs no nested transactions. Cleanup/rollback may extend beyond the transaction deadline.
    return boundedInspection
      ? await prisma.$transaction((tx) => execute(tx as unknown as LegacyDecisionRepairClient), { maxWait: 1000, timeout: 5000 })
      : await execute(prisma as unknown as LegacyDecisionRepairClient)
  } finally {
    try { await prisma?.$disconnect() } finally { await inspectionPool?.end() }
  }
}

export function inspectLegacyDecisionReviewRepair(
  pool: Pool,
  schema: string,
  manifestOverride?: LegacyDecisionRepairManifest,
  inspectionPoolFactory?: InspectionPoolFactory,
) {
  return run(pool, schema, false, manifestOverride, true, inspectionPoolFactory)
}

export async function getLegacyDecisionReviewRepairStatus(pool: Pool, schema: string, inspectionPoolFactory?: InspectionPoolFactory) {
  try {
    return { available: true as const, ...(await inspectLegacyDecisionReviewRepair(pool, schema, undefined, inspectionPoolFactory)) }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    if (code === "P2021" || code === "42P01") {
      return { available: false as const, reason: "Review tables are not provisioned in this schema." }
    }
    throw error
  }
}

export async function applyLegacyDecisionReviewRepair(
  pool: Pool,
  schema: string,
  manifestOverride?: LegacyDecisionRepairManifest,
) {
  const report = await run(pool, schema, true, manifestOverride)
  const failures = report.requests.filter(({ status }) => status === "ERROR" || status === "NOT_ELIGIBLE" || status === "READY")
  if (failures.length > 0) {
    throw new Error(`Legacy decision review repair did not reach a terminal postcondition: ${failures.map(({ requestId, code, status }) => `${requestId} (${code ?? status})`).join(", ")}`)
  }
  return report
}
