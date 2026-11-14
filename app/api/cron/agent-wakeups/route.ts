/**
 * Durable cron sweeper for `ScheduleWakeup` timers (`* * * * *` in `vercel.json`).
 *
 * Short waits (`<= 240s`) also schedule an inline `after()` timer, so this endpoint is both
 * the primary dispatcher for `5m–60m` backoffs and the crash-safe backstop for short waits.
 * Pre-121 deployments return `{ scanned: 0, fired: 0 }` cleanly instead of 500ing.
 */

import getPrisma from "@/lib/db"
import { authorizeCron, cronAuthNotConfigured } from "@/lib/cron-auth"
import { agentRunsAvailable } from "@/lib/agent-runs"
import { fireDueAgentWakeups, WAKEUP_SWEEP_BATCH_LIMIT } from "@/lib/agent-scheduled-wakeups"

export const runtime = "nodejs"
export const maxDuration = 300

const MAX_LIMIT = 100

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function sweepWakeups(request: Request) {
  if (cronAuthNotConfigured()) {
    return json({ error: "Wake-up sweeper is not configured (set CRON_SECRET)" }, 503)
  }
  if (!authorizeCron(request)) return json({ error: "Unauthorized" }, 401)

  const prisma = getPrisma()
  if (!(await agentRunsAvailable(prisma))) {
    return json({ skipped: "AGENT_RUNS_UNAVAILABLE", scanned: 0, fired: 0, deferredBusy: 0, failed: 0 })
  }

  const requested = Number(new URL(request.url).searchParams.get("limit") ?? WAKEUP_SWEEP_BATCH_LIMIT)
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT)
    : WAKEUP_SWEEP_BATCH_LIMIT

  const result = await fireDueAgentWakeups({ prisma, limit })
  if (result.fired > 0 || result.failed > 0) {
    console.info("[agent-wakeups-cron]", result)
  }
  return json(result)
}

export async function GET(request: Request) {
  return sweepWakeups(request)
}

export async function POST(request: Request) {
  return sweepWakeups(request)
}
