/**
 * Messages for one conversation, for the agent rail. The rail fetches these
 * rather than receiving them as server props — see the sibling
 * `../../route.ts` module doc for why, and for why the live workspace
 * membership check (part of the shared access predicate in
 * lib/agent-conversation-access.ts) is not redundant with the `userId` scope.
 */

import { z } from "zod"

import { auth } from "@/auth"
import { getAgentConversationMessages } from "@/lib/agent-conversations"

// `AgentConversation.id` is `@db.Uuid`. A malformed id would otherwise reach
// Postgres as a failed cast and surface as a Prisma 500; it names no
// conversation the caller could own, so it gets the same 404 as any other.
const conversationIdSchema = z.string().uuid()

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })

  const { conversationId } = await params
  if (!conversationIdSchema.safeParse(conversationId).success) {
    return new Response("Not found", { status: 404 })
  }

  // Access is proven before any message is read, and a conversation the caller
  // may not see is reported as 404 rather than 403 (null here) so existence is
  // not leaked either way.
  // Optional polling cursor (ISO timestamp). A value that does not parse is a 400
  // rather than silently falling back to "everything", which would make a buggy
  // poller re-download the whole transcript every few seconds.
  const afterParam = new URL(request.url).searchParams.get("after")
  let after: Date | undefined
  if (afterParam) {
    after = new Date(afterParam)
    if (Number.isNaN(after.getTime())) return new Response("Invalid after cursor", { status: 400 })
  }
  const messages = await getAgentConversationMessages(conversationId, workspaceId, session.user.id, { after })
  if (!messages) return new Response("Not found", { status: 404 })

  return Response.json({ messages })
}
