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
 * ## Why membership does not depend on the caller
 *
 * A route handler has no workspace layout above it, so it cannot assume the
 * user is a member of `workspaceId` — that arrives here as an unvalidated query
 * parameter from the client. The access predicate in
 * lib/agent-conversation-access.ts includes the live
 * `workspace.members` check itself, and `listAgentConversations` builds on it,
 * so this route and the agent page cannot disagree about who sees what. Scoping
 * by `userId` alone would not be enough: a user removed from a workspace could
 * still read back the titles of their old conversations there.
 */

import { auth } from "@/auth"
import { listAgentConversations } from "@/lib/agent-conversations"

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })

  const conversations = await listAgentConversations(workspaceId, session.user.id)

  return Response.json({ conversations })
}
