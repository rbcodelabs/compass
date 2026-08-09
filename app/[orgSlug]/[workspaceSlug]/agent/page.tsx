import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { AgentChat } from "@/components/agent/agent-chat"
import { listAgentConversations, getAgentConversationMessages } from "@/lib/agent-conversations"

export const metadata = { title: "Agent" }

interface AgentPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ c?: string }>
}

function initialsOf(nameOrEmail: string | null | undefined): string {
  if (!nameOrEmail) return "?"
  const name = nameOrEmail.trim()
  if (name.includes("@")) return name[0]!.toUpperCase()
  const parts = name.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name[0]!.toUpperCase()
}

export default async function AgentPage({ params, searchParams }: AgentPageProps) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const { orgSlug, workspaceSlug } = await params
  const { c: conversationId } = await searchParams
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
  let initialMessages: { id: string; role: "user" | "assistant"; content: string }[] = []
  if (conversationId) {
    const msgs = await getAgentConversationMessages(conversationId, workspace.id, userId)
    if (msgs) {
      activeConversationId = conversationId
      initialMessages = msgs.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6 md:p-8">
      <PageHeader
        title="Agent"
        description="Chat with the Compass agent — it works with this workspace's data using the tools you have access to."
      />
      <AgentChat
        workspaceId={workspace.id}
        basePath={`/${orgSlug}/${workspaceSlug}`}
        conversations={conversations.map((c) => ({ id: c.id, title: c.title }))}
        activeConversationId={activeConversationId}
        initialMessages={initialMessages}
        userInitials={initialsOf(session.user.name ?? session.user.email)}
      />
    </div>
  )
}
