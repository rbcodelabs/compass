/**
 * The Opportunities, Solutions and Tasks one agent conversation created or touched (the chat's "Linked objects" card). Same access check
 * as the chat's other reads; a conversation the caller cannot see is a 404 so existence is not leaked.
 */
import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listObjectsForConversation } from "@/lib/links/conversation-links"

const uuid = z.string().uuid()

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) return new Response("Workspace required", { status: 400 })

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) return new Response("Not found", { status: 404 })

  const items = await listObjectsForConversation(getPrisma(), { conversationId, workspaceId, userId: session.user.id })
  if (!items) return new Response("Not found", { status: 404 })
  return Response.json({ items })
}
