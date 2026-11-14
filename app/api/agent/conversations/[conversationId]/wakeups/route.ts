/**
 * Session-authenticated read and 1-click cancellation of a conversation's active `PENDING`
 * `ScheduleWakeup` timer (`Waiting` column card + `AgentChat` composer countdown pill).
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import {
  AgentWakeupError,
  cancelConversationWakeup,
  getConversationPendingWakeup,
} from "@/lib/agent-scheduled-wakeups"

export const runtime = "nodejs"

const uuid = z.string().uuid()

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return new Response("Workspace required", { status: 400 })
  }

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) {
    return new Response("Not found", { status: 404 })
  }

  try {
    const wakeup = await getConversationPendingWakeup(getPrisma(), {
      conversationId,
      workspaceId,
      userId: session.user.id,
    })
    return Response.json({ wakeup }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentWakeupError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return new Response("Workspace required", { status: 400 })
  }

  const wakeupId = url.searchParams.get("wakeupId") ?? undefined
  if (wakeupId && !uuid.safeParse(wakeupId).success) {
    return new Response("Invalid wakeupId", { status: 400 })
  }

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) {
    return new Response("Not found", { status: 404 })
  }

  try {
    const result = await cancelConversationWakeup(getPrisma(), {
      conversationId,
      workspaceId,
      userId: session.user.id,
      wakeupId,
    })
    return Response.json(result, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentWakeupError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
