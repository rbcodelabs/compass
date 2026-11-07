/**
 * PATCH → archive or restore one conversation: `{ archived: boolean }`.
 *
 * Owner-only. Anyone else (participant, non-member, unknown id) gets 404, never 403, so a
 * conversation the caller may not change is indistinguishable from one that does not exist.
 */

import { z } from "zod"

import { auth } from "@/auth"
import { setAgentConversationArchived } from "@/lib/agent-conversations"

export const runtime = "nodejs"

const uuid = z.string().uuid()
const bodySchema = z.object({ archived: z.boolean() })

export async function PATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId } = await context.params
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(workspaceId).success) {
    return new Response("Not found", { status: 404 })
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) return Response.json({ error: "archived (boolean) is required" }, { status: 400 })

  const ok = await setAgentConversationArchived(conversationId, workspaceId, session.user.id, body.data.archived)
  if (!ok) return new Response("Not found", { status: 404 })
  return Response.json({ archived: body.data.archived }, { headers: { "cache-control": "no-store" } })
}
