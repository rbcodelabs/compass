/**
 * Remove one participant, or leave.
 *
 * DELETE /participants/{userId}. The owner may remove anyone; a participant may remove
 * only themself, which is how they leave. The owner cannot leave. Removal is a soft
 * delete, so the person loses access to the conversation immediately but the messages
 * they wrote stay (and keep their attribution).
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AgentParticipantError, removeConversationParticipant } from "@/lib/agent-conversation-participants"

export const runtime = "nodejs"

const uuid = z.string().uuid()

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

export async function DELETE(
  request: Request,
  context: { params: Promise<{ conversationId: string; userId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId, userId } = await context.params
  if (![conversationId, userId, workspaceId].every((v) => uuid.safeParse(v).success)) {
    return new Response("Not found", { status: 404 })
  }

  try {
    const result = await removeConversationParticipant(getPrisma(), {
      conversationId,
      workspaceId,
      actorUserId: session.user.id,
      targetUserId: userId,
    })
    if (!result.removed) return json({ error: "That person is not a participant" }, 404)
    return json(result)
  } catch (error) {
    if (error instanceof AgentParticipantError) return json({ error: error.message, code: error.code }, error.status)
    console.error("Agent conversation removal failed", { conversationId })
    return json({ error: "Could not remove that person" }, 500)
  }
}
