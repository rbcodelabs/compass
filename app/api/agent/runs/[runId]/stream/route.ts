/**
 * Live tail of one agent run's event log.
 *
 * This is the SSE variant of the sibling snapshot route, and the important thing
 * about it is what it is *not*: it is not the connection the agent runs on. The
 * agent runs in a sandbox that reports to /api/internal/agent/runs/:runId/events
 * on its own schedule. This route only reads rows. So closing the tab kills a
 * reader, not a run, and reopening it resumes from `afterSeq` — which is the
 * entire point of detaching the run from the request.
 *
 * Everything here is therefore replaceable by polling the snapshot route (the
 * client falls back to exactly that). SSE is here to make the common case feel
 * live, not because correctness depends on it.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getAgentRunForViewer, isTerminalAgentRunStatus, listAgentRunEvents } from "@/lib/agent-runs"
import { serializeAgentRun, serializeAgentRunEvent } from "@/lib/agent-run-view"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

const PAGE_SIZE = 200
const POLL_MS = 1_000
const KEEPALIVE_MS = 15_000
/**
 * Hang up well before `maxDuration` does. A function killed mid-write drops the
 * connection without telling the client where it got to; ending deliberately lets
 * us send `reconnect` with an exact `afterSeq`, so a run longer than one function
 * lifetime is watched by a chain of readers with no gap and no replay.
 */
const TAIL_WINDOW_MS = 4 * 60_000 + 30_000

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const userId = session.user.id
  const { runId } = await context.params
  if (!uuid.test(runId)) return new Response("Not found", { status: 404 })

  const prisma = getPrisma()
  const initial = await getAgentRunForViewer({ prisma, runId, userId })
  if (!initial) return new Response("Not found", { status: 404 })

  const url = new URL(request.url)
  const requested = Number(url.searchParams.get("afterSeq") ?? 0)
  let seq = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (chunk: string) => {
        if (!open) return false
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          open = false
          return false
        }
      }
      const sse = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

      const endAt = Date.now() + TAIL_WINDOW_MS
      let lastWriteAt = Date.now()
      let status = initial.status
      let lastSeq = initial.lastSeq

      try {
        sse("run", serializeAgentRun(initial))

        while (open && !request.signal.aborted) {
          const events = await listAgentRunEvents({ prisma, runId, afterSeq: seq, take: PAGE_SIZE })
          for (const event of events) {
            if (!sse("event", serializeAgentRunEvent(event))) break
            seq = event.seq
            lastWriteAt = Date.now()
          }
          if (!open) break

          // A full page means the backlog is still draining — keep going without
          // sleeping, so replaying a long finished run is one fast pass rather
          // than one page per second.
          if (events.length === PAGE_SIZE) continue

          // Only re-read the run row when the event page came up short. In the
          // steady state that is one extra query per idle second instead of two
          // per second, and it costs at most one poll of latency on the finish.
          const refreshed = await prisma.agentRun.findUnique({
            where: { id: runId },
            select: { status: true, lastSeq: true },
          })
          if (!refreshed) break
          status = refreshed.status
          lastSeq = refreshed.lastSeq

          // Terminal *and* fully drained. Both halves matter: the terminal event
          // is written before the status flips in some orderings, and a client
          // that stops reading at the status change would lose the result.
          if (isTerminalAgentRunStatus(status) && seq >= lastSeq) {
            const done = await getAgentRunForViewer({ prisma, runId, userId })
            if (done) sse("run", serializeAgentRun(done))
            sse("done", { afterSeq: seq })
            break
          }

          if (Date.now() >= endAt) {
            sse("reconnect", { afterSeq: seq })
            break
          }
          if (Date.now() - lastWriteAt >= KEEPALIVE_MS) {
            // Comment frame: keeps intermediaries from reaping an idle connection
            // without inventing an event the client has to know about.
            send(`: keepalive\n\n`)
            lastWriteAt = Date.now()
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
      } catch (error) {
        console.error("Agent run stream failed", { runId, error })
        sse("error", { message: "Run stream interrupted", afterSeq: seq })
      } finally {
        try {
          controller.close()
        } catch {
          /* already disconnected */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform, no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
