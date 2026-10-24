/**
 * Marks one conversation as reviewed by the caller (the agent board's card click).
 *
 * The flag is per user, so this writes only the caller's row, and only after the same
 * access check the chat's reads use (lib/agent-conversation-access.ts). A conversation the
 * caller cannot see is a 404, never a 403, so existence is not leaked.
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { markConversationReviewed } from "@/lib/agent-board-data"

const uuid = z.string().uuid()

export async function POST(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) return new Response("Workspace required", { status: 400 })

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) return new Response("Not found", { status: 404 })

  const result = await markConversationReviewed(getPrisma(), { conversationId, workspaceId, userId: session.user.id })
  if (result.ok) return Response.json({ ok: true })
  if (result.reason === "not_found") return new Response("Not found", { status: 404 })
  return new Response("Reviews are not available yet", { status: 503 })
}
