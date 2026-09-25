/**
 * Messages for one conversation, for the agent rail. The rail fetches these
 * rather than receiving them as server props — see the sibling
 * `../../route.ts` module doc for why, and for why the
 * `workspace.members` predicate below is not redundant with the `userId`
 * scope.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })

  const { conversationId } = await params
  const userId = session.user.id
  const prisma = getPrisma()

  // Ownership is proven before any message is read, and a conversation the
  // caller may not see is reported as 404 rather than 403 — the same shape
  // getAgentConversationMessages uses, so existence is not leaked either way.
  const conversation = await prisma.agentConversation.findFirst({
    where: {
      id: conversationId,
      workspaceId,
      userId,
      workspace: { members: { some: { userId } } },
    },
    select: { id: true },
  })
  if (!conversation) return new Response("Not found", { status: 404 })

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true },
  })

  return Response.json({ messages })
}
