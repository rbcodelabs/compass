/**
 * Durable cron sweeper for `AgentOrchestratorWakeup` batches and activity-gated heartbeats
 * (`* * * * *` in `vercel.json`).
 *
 * Pre-122/123 deployments return zeroed counts cleanly instead of 500ing.
 */

import getPrisma from "@/lib/db"
import { authorizeCron, cronAuthNotConfigured } from "@/lib/cron-auth"
import { agentRunsAvailable } from "@/lib/agent-runs"
import {
  ORCHESTRATOR_SWEEP_BATCH_LIMIT,
  sweepOrchestratorWakeupsAndHeartbeats,
} from "@/lib/orchestrator/wakeups"

export const runtime = "nodejs"
export const maxDuration = 300

const MAX_LIMIT = 100

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function sweepOrchestrators(request: Request) {
  if (cronAuthNotConfigured()) {
    return json({ error: "Orchestrator sweeper is not configured (set CRON_SECRET)" }, 503)
  }
  if (!authorizeCron(request)) return json({ error: "Unauthorized" }, 401)

  const prisma = getPrisma()
  if (!(await agentRunsAvailable(prisma))) {
    return json({
      skipped: "AGENT_RUNS_UNAVAILABLE",
      quietPromoted: 0,
      quietExtended: 0,
      batchesDispatched: 0,
      wakeupsDispatched: 0,
      heldBusy: 0,
      dropped: 0,
      heartbeatsFired: 0,
      heartbeatsSkippedQuiet: 0,
    })
  }

  const requested = Number(
    new URL(request.url).searchParams.get("limit") ?? ORCHESTRATOR_SWEEP_BATCH_LIMIT,
  )
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT)
    : ORCHESTRATOR_SWEEP_BATCH_LIMIT

  const result = await sweepOrchestratorWakeupsAndHeartbeats({ prisma, limit })
  if (result.batchesDispatched > 0 || result.heartbeatsFired > 0) {
    console.info("[agent-orchestrator-cron]", result)
  }
  return json(result)
}

export async function GET(request: Request) {
  return sweepOrchestrators(request)
}

export async function POST(request: Request) {
  return sweepOrchestrators(request)
}
