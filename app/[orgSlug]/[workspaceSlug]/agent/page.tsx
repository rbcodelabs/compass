import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AGENT_LIST_COOKIE, parseAgentListOpen } from "@/lib/agent-list-pref"
import { AGENT_VIEW_COOKIE, resolveInitialAgentView } from "@/lib/agent-view-pref"
import { listAgentBoardCards, listWorkspaceBoardSquads } from "@/lib/agent-board-data"
import { AgentPageShell } from "@/components/agent/agent-page-shell"
import { listAgentConversations, getAgentConversationMessages } from "@/lib/agent-conversations"
import { resolveAgentHandoffContext } from "@/lib/agent-context"
import { initialsOf } from "@/lib/user-initials"

export const metadata = { title: "Agent" }

interface AgentPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ c?: string; entityType?: string; entityId?: string; agentId?: string; team?: string; child?: string }>
}

export default async function AgentPage({ params, searchParams }: AgentPageProps) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const { orgSlug, workspaceSlug } = await params
  const { c: conversationId, entityType, entityId, agentId, team, child } = await searchParams
  const prisma = getPrisma()

  // Membership is enforced by the workspace layout; scope by org+workspace slug here.
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  })
  if (!workspace) notFound()

  const userId = session.user.id
  const conversations = await listAgentConversations(workspace.id, userId)

  // Load the selected conversation's messages (falls back to a new chat if the
  // id is invalid / not owned).
  let activeConversationId: string | null = null
  let initialMessages: {
    id: string
    role: "user" | "assistant"
    content: string
    createdAt: string
    authorUserId: string | null
    authorName: string | null
  }[] = []
  if (conversationId) {
    const msgs = await getAgentConversationMessages(conversationId, workspace.id, userId)
    if (msgs) {
      activeConversationId = conversationId
      initialMessages = msgs.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        authorUserId: m.authorUserId,
        authorName: m.authorName,
      }))
    }
  }

  // "Send to agent" hand-off: only consulted for a brand-new chat — an
  // existing conversation selected via ?c= always wins (e.g. after a page
  // refresh), so we never re-seed/resolve anything once a thread exists.
  let seedEntity: { entityType: string; entityId: string; label: string; summary: string; sourceUrl: string } | undefined
  let suggestedInstruction: string | undefined
  if (!conversationId && entityType && entityId) {
    const handoff = await resolveAgentHandoffContext({ workspaceId: workspace.id, userId, entityType, entityId })
    if (handoff) {
      seedEntity = { entityType, entityId, label: handoff.label, summary: handoff.summary, sourceUrl: handoff.sourceUrl }
      suggestedInstruction = handoff.suggestedInstruction
    }
  }

  const cookieStore = await cookies()
  const listOpen = parseAgentListOpen(cookieStore.get(AGENT_LIST_COOKIE)?.value)
  // A ?c= deep link is the chat; otherwise the saved view decides. The board's cards are only loaded when it
  // is the first frame, so a chat page load pays for no extra query.
  const initialView = resolveInitialAgentView(cookieStore.get(AGENT_VIEW_COOKIE)?.value, conversationId)
  // A failed board query must not take the whole page (chat included) down: null makes the board fetch for itself.
  // The same query feeds the chat list status groups, so it runs for both views; a failure just means a flat list.
  const [boardCards, workspaceSquads] = await Promise.all([
    listAgentBoardCards(prisma, { workspaceId: workspace.id, userId }).catch(() => null),
    listWorkspaceBoardSquads(prisma, { workspaceId: workspace.id, userId }).catch(() => []),
  ])
  const initialBoardCards = initialView === "board" ? boardCards : null
  const statusById = new Map((boardCards ?? []).map((card) => [card.id, card]))

  return (
    <AgentPageShell
      workspaceId={workspace.id}
      basePath={`/${orgSlug}/${workspaceSlug}`}
      conversations={conversations.map((c) => {
        const card = statusById.get(c.id)
        return {
          id: c.id,
          title: c.title,
          ...(card
            ? {
                messageCount: card.messageCount,
                runStatus: card.runStatus,
                lastActivityAt: card.lastActivityAt,
                reviewedAt: card.reviewedAt,
                squad: card.squad,
                summary: card.summary,
                prUrl: card.prUrl,
                substatus: card.substatus,
                currentActivity: card.currentActivity,
                lastHeartbeatAt: card.lastHeartbeatAt,
                subtasks: card.subtasks,
                childAgents: card.childAgents,
              }
            : {}),
        }
      })}
      activeConversationId={activeConversationId}
      initialMessages={initialMessages}
      userId={userId}
      userInitials={initialsOf(session.user.name ?? session.user.email)}
      seedEntity={seedEntity}
      suggestedInstruction={suggestedInstruction}
      initialAgentId={agentId}
      initialTeamOpen={team === "1"}
      initialChildRunId={child}
      initialListOpen={listOpen}
      initialView={initialView}
      initialBoardCards={initialBoardCards}
      initialSquads={workspaceSquads}
    />
  )
}
