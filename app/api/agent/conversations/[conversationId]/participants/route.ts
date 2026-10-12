/**
 * Participants of one agent conversation.
 *
 * GET  → who is in it, the caller's role, and (with `?candidates=1`) which workspace
 *        members could still be invited.
 * POST → invite a workspace member: `{ userId }`. Any participant may invite; there is
 *        no cap. Idempotent.
 *
 * Removing and leaving live in `./[userId]`. The rules themselves are in
 * lib/agent-conversation-participants.ts; this file only maps them to HTTP. A caller
 * with no access to the conversation gets 404, never 403.
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AgentParticipantError, addConversationParticipant, listConversationParticipants } from "@/lib/agent-conversation-participants"

export const runtime = "nodejs"

const uuid = z.string().uuid()
const bodySchema = z.object({ userId: z.string().uuid() })

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId } = await context.params
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(workspaceId).success) {
    return new Response("Not found", { status: 404 })
  }

  const result = await listConversationParticipants(getPrisma(), {
    conversationId,
    workspaceId,
    actorUserId: session.user.id,
    includeCandidates: url.searchParams.get("candidates") === "1",
  })
  if (!result) return new Response("Not found", { status: 404 })
  return json(result)
}

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId } = await context.params
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(workspaceId).success) {
    return new Response("Not found", { status: 404 })
  }

  const body = bodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: "userId is required" }, 400)

  try {
    const result = await addConversationParticipant(getPrisma(), {
      conversationId,
      workspaceId,
      actorUserId: session.user.id,
      inviteeUserId: body.data.userId,
    })
    return json(result, result.added ? 201 : 200)
  } catch (error) {
    if (error instanceof AgentParticipantError) return json({ error: error.message, code: error.code }, error.status)
    console.error("Agent conversation invite failed", { conversationId })
    return json({ error: "Could not add that person" }, 500)
  }
}
