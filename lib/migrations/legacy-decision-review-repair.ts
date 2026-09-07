import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import type { Pool } from "pg"
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
): Promise<LegacyDecisionReviewRepairReport> {
  const manifest = parseLegacyDecisionRepairManifest(manifestOverride ?? productionManifest)
  const prisma = createClient(pool, schema)
  try {
    // Missing tables are migration-system errors. Only a genuine absent target
    // workspace is a safe no-op in dev/preview schemas.
    const workspace = await prisma.workspace.findUnique({ where: { id: manifest.workspaceId }, select: { id: true } })
    if (!workspace) {
      return { workspaceId: manifest.workspaceId, workspaceStatus: "NOT_PRESENT", mode: apply ? "APPLY" : "DRY_RUN", requests: [] }
    }

    const report = await repairLegacyDecisionRequests(
      prisma as unknown as LegacyDecisionRepairClient,
      manifest,
      { apply },
    )
    return summarize(report, "PRESENT")
  } finally {
    await prisma.$disconnect()
  }
}

export function inspectLegacyDecisionReviewRepair(
  pool: Pool,
  schema: string,
  manifestOverride?: LegacyDecisionRepairManifest,
) {
  return run(pool, schema, false, manifestOverride)
}

export async function getLegacyDecisionReviewRepairStatus(pool: Pool, schema: string) {
  try {
    return { available: true as const, ...(await inspectLegacyDecisionReviewRepair(pool, schema)) }
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
