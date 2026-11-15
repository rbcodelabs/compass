/**
 * Session-authenticated endpoint backing the floating `OrchestratorDock`:
 *   - `GET`: returns the caller's Workspace Orchestrator transcript + active run state
 *   - `POST`: auto-provisions/enables the caller's Workspace Orchestrator and dispatches a turn
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import {
  AgentSupervisionError,
  getOrchestratorDockState,
  sendOrchestratorDockMessage,
} from "@/lib/agent-supervision-actions"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = z.string().uuid()
const postSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(8_000),
})

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return Response.json({ error: "Workspace required.", code: "INVALID_WORKSPACE" }, { status: 400 })
  }

  try {
    const state = await getOrchestratorDockState(getPrisma(), {
      workspaceId,
      userId: session.user.id,
    })
    return Response.json(state, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentSupervisionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const rawBody = await request.json().catch(() => null)
  const parsed = postSchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: "A valid workspaceId and message are required.", code: "INVALID_PAYLOAD" }, { status: 400 })
  }

  try {
    const result = await sendOrchestratorDockMessage({
      prisma: getPrisma(),
      workspaceId: parsed.data.workspaceId,
      userId: session.user.id,
      message: parsed.data.message,
    })
    return Response.json(result, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentSupervisionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error("[orchestrator-dock] failed to send message", { error })
    return Response.json({ error: "Could not send message to Workspace Orchestrator." }, { status: 500 })
  }
}
