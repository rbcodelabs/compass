/**
 * Conversation list for the agent rail (components/agent/agent-rail.tsx).
 *
 * ## Why this route exists when lib/agent-conversations.ts already does this
 *
 * `listAgentConversations` is callable only from a server component, and the
 * agent *page* uses it that way. The rail cannot: it is mounted in the
 * workspace layout so that an in-flight turn keeps streaming while the user
 * moves between screens, which means it is never re-rendered by a navigation
 * and so never receives fresh server props. It has to fetch.
 *
 * ## Why the membership check is repeated here and not delegated
 *
 * The helpers in lib/agent-conversations.ts scope by `(workspaceId, userId)`
 * and rely on the workspace layout having already established that the user is
 * a member of that workspace — their doc comment says so explicitly. A route
 * handler has no layout above it, so that assumption does not hold: a
 * `workspaceId` arrives here as an unvalidated query parameter from the client.
 *
 * Without the `workspace.members` predicate below, any authenticated user could
 * pass an arbitrary workspace id and read back the titles of their own
 * conversations in a workspace they were removed from — or, if they ever held a
 * row there, after losing access. Scoping by `userId` alone is not sufficient,
 * because the rows are keyed by user *and* workspace and only the latter
 * encodes the authorization boundary. This mirrors
 * `conversations/[conversationId]/processing/route.ts`, which makes the same
 * check for the same reason.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })

  const userId = session.user.id
  const conversations = await getPrisma().agentConversation.findMany({
    where: {
      workspaceId,
      userId,
      // The authorization boundary — see the module doc.
      workspace: { members: { some: { userId } } },
    },
    orderBy: { updatedAt: "desc" },
    // Same cap as listAgentConversations, so the rail and the full page show
    // the same set rather than disagreeing at the tail.
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  })

  return Response.json({ conversations })
}
