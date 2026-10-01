/**
 * Collect agent runs that nobody is going to finish.
 *
 * This route is the reason a detached run is safe to start at all. The old
 * synchronous turn cleaned up in a `finally` that only ran while a browser stayed
 * connected; a detached run has no such moment, so *something* has to notice a
 * worker that died mid-turn and release its interview claim, revoke its MCP key,
 * and stop its sandbox. That something is `sweepAgentRuns`, called from here once
 * a minute.
 *
 * Invocation: Vercel Cron issues an **HTTP GET** against the production URL in
 * UTC (see vercel.json). POST is accepted too, purely so an operator can trigger a
 * sweep by hand with the same credential.
 *
 * Auth: `CRON_SECRET` as a bearer token — the header Vercel Cron sends — with
 * `MIGRATION_SECRET` accepted as the manual-operator fallback, which is the same
 * trust boundary /api/admin/* already uses. With neither configured the route
 * fails closed (503) rather than running unauthenticated: a sweeper is a
 * termination endpoint, and an anonymous caller must never be able to reach one.
 */

import { timingSafeEqual } from "node:crypto"
import getPrisma from "@/lib/db"
import { agentRunsAvailable, sweepAgentRuns } from "@/lib/agent-runs"

export const runtime = "nodejs"
// A batch can stop up to `limit` sandboxes, each a network round trip.
export const maxDuration = 300

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

/** Length-independent, then constant-time. Never leaks which secret matched. */
function secretMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authorize(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  const migrationSecret = process.env.MIGRATION_SECRET
  if (!cronSecret && !migrationSecret) return false
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
  return (
    secretMatches(bearer, cronSecret) ||
    secretMatches(bearer, migrationSecret) ||
    secretMatches(request.headers.get("x-migration-secret") ?? undefined, migrationSecret)
  )
}

async function sweep(request: Request) {
  if (!process.env.CRON_SECRET && !process.env.MIGRATION_SECRET) {
    return json({ error: "Sweeper is not configured (set CRON_SECRET)" }, 503)
  }
  if (!authorize(request)) return json({ error: "Unauthorized" }, 401)

  const prisma = getPrisma()
  // Before migration 069 the tables do not exist, and a cron that 500s every
  // minute is indistinguishable from a real outage in the logs.
  if (!(await agentRunsAvailable(prisma))) {
    return json({ skipped: "AGENT_RUNS_UNAVAILABLE", examined: 0, swept: [], failed: [] })
  }

  const requested = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT) : DEFAULT_LIMIT

  const result = await sweepAgentRuns({ prisma, limit })
  // Logged, not just returned: nothing reads a cron's response body, and a run
  // being force-terminated is exactly the event worth having in the logs.
  if (result.swept.length > 0 || result.failed.length > 0) {
    console.warn("[agent-run-sweeper]", {
      examined: result.examined,
      swept: result.swept,
      failed: result.failed,
      truncated: result.truncated,
    })
  }
  return json(result)
}

export async function GET(request: Request) {
  return sweep(request)
}

export async function POST(request: Request) {
  return sweep(request)
}
