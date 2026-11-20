/**
 * PATCH → archive or restore one conversation: `{ archived: boolean }`. There is no DELETE: archive is the only way to
 * take a conversation out of the way, and it is always reversible (TASK-195 S2).
 *
 * Shared conversations: the thread starter, a workspace admin or an org admin (lib/conversation-archive.ts). Private
 * chats: owner only. A conversation the caller cannot see is a 404, never a 403; a member who can see a shared one but
 * has no right to archive it gets a 403. Repeating the call is safe and answers 200 with `changed: false`.
 */

import { z } from "zod"

import { auth } from "@/auth"
import { setConversationArchived } from "@/lib/conversation-archive"

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

  const result = await setConversationArchived({ conversationId, workspaceId, userId: session.user.id, archived: body.data.archived })
  if (!result.ok) return new Response(result.status === 403 ? "Forbidden" : "Not found", { status: result.status })
  return Response.json({ archived: result.archived, changed: result.changed }, { headers: { "cache-control": "no-store" } })
}
