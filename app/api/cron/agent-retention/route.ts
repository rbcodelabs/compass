/**
 * Daily retention pruning of agent conversation data (see lib/agent-retention.ts for the policy).
 *
 * Invocation and auth are identical to the agent-run sweeper: Vercel Cron issues a GET with
 * `Authorization: Bearer $CRON_SECRET`; POST with the same credential (or MIGRATION_SECRET) runs it by hand.
 * Unlike the sweeper, this route requires CRON_SECRET specifically: MIGRATION_SECRET alone is not enough to be considered
 * configured, because Vercel Cron only ever sends CRON_SECRET, so a deployment with just MIGRATION_SECRET would silently
 * never run the schedule while the policy promises it does. It answers 503 and logs loudly when that happens.
 */
import getPrisma from "@/lib/db"
import { pruneAgentData } from "@/lib/agent-retention"
import { authorizeCron, looksLikeVercelCron } from "@/lib/cron-auth"

export const runtime = "nodejs"
export const maxDuration = 300

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function prune(request: Request) {
  if (!process.env.CRON_SECRET) {
    if (looksLikeVercelCron(request)) {
      console.error("[agent-retention] CRON_SECRET is not set but Vercel Cron is calling this route: RETENTION IS NOT RUNNING. Set CRON_SECRET.")
    }
    return json({ error: "Retention job is not configured (set CRON_SECRET)" }, 503)
  }
  if (!authorizeCron(request)) return json({ error: "Unauthorized" }, 401)
  try {
    const result = await pruneAgentData({ prisma: getPrisma() })
    // Logged as well as returned: nothing reads a cron's response body, and a deletion job needs an audit trail.
    console.info("[agent-retention]", result)
    return json(result)
  } catch (error) {
    console.error("[agent-retention] failed", error)
    return json({ error: "Retention run failed" }, 500)
  }
}

export async function GET(request: Request) {
  return prune(request)
}

export async function POST(request: Request) {
  return prune(request)
}
