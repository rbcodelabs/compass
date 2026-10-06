import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AGENT_LIST_COOKIE, parseAgentListOpen } from "@/lib/agent-list-pref"
import { AgentPageShell } from "@/components/agent/agent-page-shell"
import { listAgentConversations, getAgentConversationMessages } from "@/lib/agent-conversations"
import { resolveAgentHandoffContext } from "@/lib/agent-context"
import { initialsOf } from "@/lib/user-initials"

export const metadata = { title: "Agent" }

interface AgentPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ c?: string; entityType?: string; entityId?: string }>
}

export default async function AgentPage({ params, searchParams }: AgentPageProps) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const { orgSlug, workspaceSlug } = await params
  const { c: conversationId, entityType, entityId } = await searchParams
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

  const listOpen = parseAgentListOpen((await cookies()).get(AGENT_LIST_COOKIE)?.value)

  return (
    <AgentPageShell
      workspaceId={workspace.id}
      basePath={`/${orgSlug}/${workspaceSlug}`}
      conversations={conversations.map((c) => ({ id: c.id, title: c.title }))}
      activeConversationId={activeConversationId}
      initialMessages={initialMessages}
      userId={userId}
      userInitials={initialsOf(session.user.name ?? session.user.email)}
      seedEntity={seedEntity}
      suggestedInstruction={suggestedInstruction}
      initialListOpen={listOpen}
    />
  )
}
