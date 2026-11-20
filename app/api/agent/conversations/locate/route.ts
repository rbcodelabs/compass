/**
 * GET /api/agent/conversations/locate?workspaceId=&messageId=
 *
 * Which conversation holds this message (or comment)? The answer old `?comment=<id>` links need to open the Conversation
 * panel on the right thread with the message highlighted (TASK-195 S3). The rules live in lib/conversation-locate.ts.
 *
 * Every way of not being able to read the thread, and every malformed or unknown id, is the same bare 404, so this
 * route cannot be used to learn whether a conversation, comment or message exists, or what it is called or says.
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { locateConversationMessage } from "@/lib/conversation-locate"

const uuid = z.string().uuid()
const NOT_FOUND_HEADERS = { "cache-control": "private, no-store" }

const notFound = () => new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS })

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const params = new URL(request.url).searchParams
  const workspaceId = params.get("workspaceId")
  const messageId = params.get("messageId")
  if (!workspaceId || !messageId) return new Response("workspaceId and messageId are required", { status: 400 })
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(messageId).success) return notFound()

  const located = await locateConversationMessage(getPrisma(), { workspaceId, userId: session.user.id, messageId })
  if (!located) return notFound()
  return Response.json(located, { headers: NOT_FOUND_HEADERS })
}
