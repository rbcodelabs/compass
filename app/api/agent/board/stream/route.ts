/**
 * Workspace-scoped SSE stream for the agent board and chat-list live status.
 *
 * Mirrors `app/api/agent/runs/[runId]/stream/route.ts`: non-owning reader that emits an
 * initial `snapshot` (`{ cards, cursor }`), then diffs subsequent reads via
 * `diffAgentBoardCards` and only emits `patch` (`{ upserts, removedIds, cursor }`) when
 * cards actually change or disappear. Closes cleanly with `reconnect` before `maxDuration`
 * so `EventSource` or a custom reader reconnects without gaps, and clients fall back to
 * `/api/agent/board` polling if SSE is unavailable.
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { diffAgentBoardCards } from "@/lib/agent-board"
import { listAgentBoardCards } from "@/lib/agent-board-data"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = z.string().uuid()
const POLL_MS = 1_500
const KEEPALIVE_MS = 15_000
const TAIL_WINDOW_MS = 4 * 60_000 + 30_000

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const userId = session.user.id

  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return new Response("Workspace required", { status: 400 })
  }

  const prisma = getPrisma()
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
      let fingerprints = new Map<string, string>()

      try {
        const initialCards = await listAgentBoardCards(prisma, { workspaceId, userId })
        const initialDiff = diffAgentBoardCards(fingerprints, initialCards)
        fingerprints = initialDiff.nextFingerprints
        let cursor = new Date().toISOString()

        if (!sse("snapshot", { cards: initialCards, cursor })) return

        while (open && !request.signal.aborted) {
          if (Date.now() >= endAt) {
            sse("reconnect", { cursor })
            break
          }

          await abortableSleep(POLL_MS, request.signal)
          if (!open || request.signal.aborted) break

          const nextCards = await listAgentBoardCards(prisma, { workspaceId, userId })
          const { nextFingerprints, upserts, removedIds } = diffAgentBoardCards(fingerprints, nextCards)
          fingerprints = nextFingerprints

          if (upserts.length > 0 || removedIds.length > 0) {
            cursor = new Date().toISOString()
            if (!sse("patch", { upserts, removedIds, cursor })) break
            lastWriteAt = Date.now()
          } else if (Date.now() - lastWriteAt >= KEEPALIVE_MS) {
            if (!send(`: keepalive\n\n`)) break
            lastWriteAt = Date.now()
          }
        }
      } catch (error) {
        console.error("Agent board stream failed", { workspaceId, error })
        sse("error", { message: "Board stream interrupted" })
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
