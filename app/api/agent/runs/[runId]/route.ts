/**
 * One agent run, for the tab that wants to watch it.
 *
 * GET    → snapshot + events after `afterSeq`. This is a plain poller: no SSE, no
 *          open connection, no dependency on the run's own request still existing.
 *          Everything it returns comes out of the database, which is the whole
 *          point of — the transcript is durable, so any number of tabs
 *          can read it, at any time, including after the run finished.
 * DELETE → cancel. The user asked to stop; the sandbox notices on its next
 *          heartbeat and stops burning model spend.
 *
 * Session-authed (this path is allowlisted in lib/route-access.ts so the caller
 * gets a 401 rather than a login redirect). `getAgentRunForViewer` re-checks
 * workspace membership on top of run ownership — a user removed from a workspace
 * must not keep reading runs they started while they were in it.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AgentRunError, cancelAgentRun, getAgentRunForViewer, listAgentRunEvents } from "@/lib/agent-runs"
import { serializeAgentRun, serializeAgentRunEvent } from "@/lib/agent-run-view"

export const runtime = "nodejs"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

function parseAfterSeq(value: string | null): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const { runId } = await context.params
  if (!uuid.test(runId)) return new Response("Not found", { status: 404 })

  const prisma = getPrisma()
  const run = await getAgentRunForViewer({ prisma, runId, userId: session.user.id })
  if (!run) return new Response("Not found", { status: 404 })

  const url = new URL(request.url)
  const afterSeq = parseAfterSeq(url.searchParams.get("afterSeq"))
  const events = url.searchParams.get("events") === "0"
    ? []
    : await listAgentRunEvents({ prisma, runId, afterSeq })

  // `nextSeq` is what the caller sends back as `afterSeq`, and it is the last
  // event actually returned — NOT `run.lastSeq`. The two differ whenever the page
  // size truncates, and using lastSeq there would silently skip the remainder.
  const nextSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq
  return json({
    run: serializeAgentRun(run),
    events: events.map(serializeAgentRunEvent),
    nextSeq,
    hasMore: nextSeq < run.lastSeq,
  })
}

export async function DELETE(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const { runId } = await context.params
  if (!uuid.test(runId)) return new Response("Not found", { status: 404 })

  try {
    // Ownership is `cancelAgentRun`'s own `where` clause, so there is no
    // read-then-write gap to exploit here. Cancel is first-write-wins like every
    // other terminal transition: canceling a run that just succeeded returns
    // `canceled: false` and its real status rather than rewriting history.
    const result = await cancelAgentRun({ prisma: getPrisma(), runId, userId: session.user.id })
    return json({ status: result.status, canceled: result.finalized })
  } catch (error) {
    if (error instanceof AgentRunError) return json({ error: error.message, code: error.code }, error.status)
    console.error("Agent run cancel failed", { runId })
    return json({ error: "Agent run could not be canceled" }, 500)
  }
}
