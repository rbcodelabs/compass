/**
 * Daily retention pruning of agent conversation data (see lib/agent-retention.ts for the policy).
 *
 * Invocation and auth are identical to the agent-run sweeper: Vercel Cron issues a GET with
 * `Authorization: Bearer $CRON_SECRET`; POST with the same credential (or MIGRATION_SECRET) runs it by hand.
 * With neither secret configured the route answers 503 instead of running unauthenticated: it deletes data.
 */
import getPrisma from "@/lib/db"
import { pruneAgentData } from "@/lib/agent-retention"
import { authorizeCron, cronAuthNotConfigured } from "@/lib/cron-auth"

export const runtime = "nodejs"
export const maxDuration = 300

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function prune(request: Request) {
  if (cronAuthNotConfigured()) return json({ error: "Retention job is not configured (set CRON_SECRET)" }, 503)
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
