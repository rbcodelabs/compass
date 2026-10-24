/**
 * SSE channel from the server to an opted-in tab.
 *
 * Delivers `command` frames the agent queued for this session. Like the agent
 * run stream (ADR-0017) this only reads rows: closing the tab kills a reader,
 * not any state, and the client simply reconnects. The loop doubles as the
 * session heartbeat so a live stream keeps the session addressable and a dead
 * one lets it lapse.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { claimPendingUiCommands, heartbeatUiSession } from "@/lib/ui-control"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const POLL_MS = 700
const KEEPALIVE_MS = 15_000
const TAIL_WINDOW_MS = 4 * 60_000 + 30_000

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const userId = session.user.id
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? ""
  if (!uuid.test(sessionId)) return new Response("Not found", { status: 404 })

  const prisma = getPrisma()
  const owned = await prisma.uiSession.findFirst({ where: { id: sessionId, userId, status: "ACTIVE" }, select: { id: true } })
  if (!owned) return new Response("Session ended.", { status: 410 })

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
      let lastBeat = 0

      try {
        sse("ready", { sessionId })
        while (open && !request.signal.aborted) {
          if (Date.now() - lastBeat >= 10_000) {
            const alive = await heartbeatUiSession({ prisma, sessionId, userId })
            lastBeat = Date.now()
            if (!alive) {
              sse("ended", {})
              break
            }
          }
          const commands = await claimPendingUiCommands({ prisma, sessionId, userId })
          for (const command of commands) {
            sse("command", command)
            lastWriteAt = Date.now()
          }
          if (Date.now() >= endAt) {
            sse("reconnect", {})
            break
          }
          if (Date.now() - lastWriteAt >= KEEPALIVE_MS) {
            send(`: keepalive\n\n`)
            lastWriteAt = Date.now()
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
      } catch (error) {
        console.error("UI control stream failed", { sessionId, error })
        sse("error", { message: "Stream interrupted" })
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
      "X-Accel-Buffering": "no",
    },
  })
}
