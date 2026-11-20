/**
 * Edit one message in a shared conversation (TASK-195 S1).
 *
 * Who may edit is decided in lib/conversation-messages.ts from the session user, never from the request body: the
 * author or a workspace administrator. A conversation the caller cannot see is a 404, one they can see but may not
 * edit is a 403. Errors are fixed sentences and never carry message text.
 */

import { z } from "zod"

import { auth } from "@/auth"
import { editConversationMessage } from "@/lib/conversation-messages"

const idSchema = z.string().uuid()

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ conversationId: string; messageId: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })

  const { conversationId, messageId } = await params
  if (!idSchema.safeParse(conversationId).success || !idSchema.safeParse(messageId).success) {
    return new Response("Not found", { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }
  const content = (body as { content?: unknown } | null)?.content
  if (typeof content !== "string") return new Response("Message content required", { status: 400 })

  const result = await editConversationMessage({ conversationId, messageId, workspaceId, userId: session.user.id, content })
  if (!result.ok) return new Response(result.error, { status: result.status })
  return Response.json({ message: result.message })
}
