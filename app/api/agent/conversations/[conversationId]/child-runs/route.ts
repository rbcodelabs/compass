/**
 * Durable child sub-agent runs (`Task` / `Agent` SDK spawns) for one conversation, backing the
 * composer sub-agent team pill, hierarchy popover, and sticky breadcrumb drill-down timeline.
 * Same access check as the chat's other reads; an inaccessible conversation returns 404.
 */
import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listConversationChildRuns } from "@/lib/agent-child-runs"

const uuid = z.string().uuid()

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) return new Response("Workspace required", { status: 400 })

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) return new Response("Not found", { status: 404 })

  const childRuns = await listConversationChildRuns(getPrisma(), {
    conversationId,
    workspaceId,
    userId: session.user.id,
  })
  if (!childRuns) return new Response("Not found", { status: 404 })
  return Response.json({ childRuns })
}
