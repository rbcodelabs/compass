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
import {
  backfillUnifiedConversations,
  PROTOTYPE_MOCK_CONVERSATION_IDS,
  PROTOTYPE_MOCK_TASK_IDS,
} from "@/lib/unified-conversations-backfill"
import {
  defaultAgentModeForVisibility,
  isConversationStatus,
  isConversationVisibility,
  normalizeAgentParticipationMode,
  type AgentParticipationMode,
  type ConversationStatus,
  type ConversationVisibility,
} from "@/lib/agent-participation-mode"

export const metadata = { title: "Conversations" }

interface ConversationsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{
    c?: string
    entityType?: string
    entityId?: string
    agentId?: string
    team?: string
    child?: string
  }>
}

export default async function ConversationsPage({ params, searchParams }: ConversationsPageProps) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const { orgSlug, workspaceSlug } = await params
  const { c: conversationId, entityType, entityId, agentId, team, child } = await searchParams
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  })
  if (!workspace) notFound()

  const userId = session.user.id

  // Clean up any prototype mock rows if present in dev DB and idempotently promote legacy Comment threads.
  await Promise.all([
    prisma.agentMessage
      .deleteMany({ where: { conversationId: { in: [...PROTOTYPE_MOCK_CONVERSATION_IDS] } } })
      .catch(() => {}),
    prisma.agentConversation
      .deleteMany({ where: { id: { in: [...PROTOTYPE_MOCK_CONVERSATION_IDS] } } })
      .catch(() => {}),
    prisma.task
      .deleteMany({ where: { id: { in: [...PROTOTYPE_MOCK_TASK_IDS] } } })
      .catch(() => {}),
    backfillUnifiedConversations(prisma, { workspaceId: workspace.id, fallbackUserId: userId }).catch(() => {}),
  ])

  const conversations = await listAgentConversations(workspace.id, userId)
  const unifiedMetaById = new Map<
    string,
    {
      visibility: ConversationVisibility
      threadStatus: ConversationStatus
      agentMode: AgentParticipationMode
      targetType: string | null
      targetId: string | null
    }
  >()
  if (conversations.length > 0) {
    try {
      const metaRows = await prisma.agentConversation.findMany({
        where: { id: { in: conversations.map((c) => c.id) } },
        select: {
          id: true,
          visibility: true,
          status: true,
          agentMode: true,
          targetType: true,
          targetId: true,
        },
      })
      for (const row of metaRows) {
        const visibility: ConversationVisibility = isConversationVisibility(row.visibility)
          ? row.visibility
          : row.targetType && row.targetId
            ? "WORKSPACE"
            : "PRIVATE"
        const threadStatus: ConversationStatus = isConversationStatus(row.status) ? row.status : "OPEN"
        const agentMode: AgentParticipationMode = normalizeAgentParticipationMode(
          row.agentMode,
          defaultAgentModeForVisibility(visibility, Boolean(row.targetType && row.targetId)),
        )
        unifiedMetaById.set(row.id, {
          visibility,
          threadStatus,
          agentMode,
          targetType: row.targetType ?? null,
          targetId: row.targetId ?? null,
        })
      }
    } catch {
      // Pre-124 fallback: unified metadata columns not present yet.
    }
  }

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

  let seedEntity:
    | { entityType: string; entityId: string; label: string; summary: string; sourceUrl: string }
    | undefined
  let suggestedInstruction: string | undefined
  if (!conversationId && entityType && entityId) {
    const handoff = await resolveAgentHandoffContext({
      workspaceId: workspace.id,
      userId,
      entityType,
      entityId,
    })
    if (handoff) {
      seedEntity = {
        entityType,
        entityId,
        label: handoff.label,
        summary: handoff.summary,
        sourceUrl: handoff.sourceUrl,
      }
      suggestedInstruction = handoff.suggestedInstruction
    }
  }

  const cookieStore = await cookies()
  const listOpen = parseAgentListOpen(cookieStore.get(AGENT_LIST_COOKIE)?.value)
  const initialView = resolveInitialAgentView(cookieStore.get(AGENT_VIEW_COOKIE)?.value, conversationId)
  const [boardCards, workspaceSquads] = await Promise.all([
    listAgentBoardCards(prisma, { workspaceId: workspace.id, userId }).catch(() => null),
    listWorkspaceBoardSquads(prisma, { workspaceId: workspace.id, userId }).catch(() => []),
  ])
  const initialBoardCards = initialView === "board" ? boardCards : null
  const statusById = new Map((boardCards ?? []).map((card) => [card.id, card]))
  const activeMeta = activeConversationId ? unifiedMetaById.get(activeConversationId) : undefined

  return (
    <AgentPageShell
      title="Conversations"
      routeSegment="conversations"
      workspaceId={workspace.id}
      basePath={`/${orgSlug}/${workspaceSlug}`}
      conversations={conversations.map((c) => {
        const card = statusById.get(c.id)
        const meta = unifiedMetaById.get(c.id)
        return {
          id: c.id,
          title: c.title,
          ...(meta
            ? {
                visibility: meta.visibility,
                threadStatus: meta.threadStatus,
                agentMode: meta.agentMode,
                targetType: meta.targetType,
                targetId: meta.targetId,
              }
            : {}),
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
                pendingQuestions: card.pendingQuestions,
                scheduledWakeup: card.scheduledWakeup ?? null,
                orchestratorRole: card.orchestratorRole ?? null,
                managerNotes: card.managerNotes ?? null,
                proposedReply: card.proposedReply ?? null,
                pendingDecisions: card.pendingDecisions,
              }
            : {}),
        }
      })}
      activeConversationId={activeConversationId}
      initialMessages={initialMessages}
      initialAgentMode={activeMeta?.agentMode}
      initialVisibility={activeMeta?.visibility}
      initialStatus={activeMeta?.threadStatus}
      initialTargetType={activeMeta?.targetType}
      initialTargetId={activeMeta?.targetId}
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
