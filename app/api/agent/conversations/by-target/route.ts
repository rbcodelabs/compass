import { NextRequest } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import {
  defaultAgentModeForVisibility,
  isConversationStatus,
  isConversationVisibility,
  normalizeAgentParticipationMode,
  type AgentParticipationMode,
  type ConversationStatus,
  type ConversationVisibility,
} from "@/lib/agent-participation-mode"
import {
  isConversationLinkTarget,
  listConversationsForObject,
  type ObjectConversationLink,
} from "@/lib/links/conversation-links"
import { loadMentionCandidates, type MentionCandidates } from "@/lib/doc-comment-tasks"
import { plainTextOf } from "@/lib/comment-mentions"
import { listRestorableArchivedConversations } from "@/lib/conversation-archive"
import { backfillUnifiedConversations } from "@/lib/unified-conversations-backfill"

export const runtime = "nodejs"

const BUILTIN_COMPASS_AGENT_ID = "00000000-0000-4000-8000-000000000001"

function withBuiltInCompassAgent(candidates: MentionCandidates): MentionCandidates {
  const hasCompassAgent = candidates.agents.some(
    (a) => a.name.trim().toLowerCase() === "compass agent",
  )
  if (hasCompassAgent) return candidates
  return {
    ...candidates,
    agents: [
      {
        kind: "agent",
        id: BUILTIN_COMPASS_AGENT_ID,
        name: "Compass Agent",
        detail: "Workspace AI assistant",
        access: "WRITE",
        agentKind: "CLOUD",
      },
      ...candidates.agents,
    ],
  }
}

export type ObjectConversationSummary = {
  id: string
  title: string
  summary: string | null
  status: ConversationStatus
  agentMode: AgentParticipationMode
  visibility: ConversationVisibility
  messageCount: number
  updatedAt: string
  anchored: boolean
  links: Array<Pick<ObjectConversationLink, "linkId" | "kind" | "auto">>
  /** Present (true) only on rows returned for `archived=1`; those are only ever rows the caller may restore. */
  archived?: true
  canRestore?: true
  canArchive?: true
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")
  const targetType = request.nextUrl.searchParams.get("targetType")?.trim().toUpperCase()
  const targetId = request.nextUrl.searchParams.get("targetId")?.trim()
  if (!workspaceId) {
    return Response.json(
      { error: "workspaceId is required." },
      { status: 400 },
    )
  }

  const userId = session.user.id
  const prisma = getPrisma()
  const wantsArchived = request.nextUrl.searchParams.get("archived") === "1"

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { userId: true },
  })
  if (!membership) return new Response("Not found", { status: 404 })

  const mentionOptions = await loadMentionCandidates(workspaceId)
    .then(withBuiltInCompassAgent)
    .catch((): MentionCandidates => ({
      people: [],
      agents: [
        {
          kind: "agent",
          id: BUILTIN_COMPASS_AGENT_ID,
          name: "Compass Agent",
          detail: "Workspace AI assistant",
          access: "WRITE",
          agentKind: "CLOUD",
        },
      ],
      outside: [],
    }))

  if (!targetType || !targetId) {
    return Response.json({ items: [], mentionOptions })
  }

  await backfillUnifiedConversations(prisma, { workspaceId, fallbackUserId: userId }).catch(() => {})

  const accessWhere = accessibleConversationsWhere(workspaceId, userId)
  let linked: ObjectConversationLink[] = []
  let linksLoaded = false
  try {
    linked = isConversationLinkTarget(targetType)
      ? await listConversationsForObject(prisma, {
          workspaceId,
          entityType: targetType,
          entityId: targetId,
          userId,
        })
      : []
    linksLoaded = true
    const linkedIds = linked.map((l) => l.conversationId)

    // `archived=1` swaps the list for the archived rows this caller may restore (the starter, or an admin). Anything
    // else stays out of the response entirely, so an archived title or summary never reaches someone who cannot act on it.
    const rows = wantsArchived
      ? await listRestorableArchivedConversations({ workspaceId, userId, targetType, targetId, linkedIds })
      : await prisma.agentConversation.findMany({
      where: {
        archivedAt: null,
        AND: [
          accessWhere,
          { OR: [
            { targetType, targetId },
            ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : []),
          ] },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        summary: true,
        status: true,
        agentMode: true,
        visibility: true,
        targetType: true,
        targetId: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    })

    const items: ObjectConversationSummary[] = rows.map((row) => {
      const visibility: ConversationVisibility = isConversationVisibility(row.visibility)
        ? row.visibility
        : row.targetType && row.targetId
          ? "WORKSPACE"
          : "PRIVATE"
      const status: ConversationStatus = isConversationStatus(row.status) ? row.status : "OPEN"
      const agentMode: AgentParticipationMode = normalizeAgentParticipationMode(
        row.agentMode,
        defaultAgentModeForVisibility(visibility, Boolean(row.targetType && row.targetId)),
      )
      return {
        id: row.id,
        title: plainTextOf(row.title?.trim() || "Conversation"),
        summary: row.summary ? plainTextOf(row.summary) : null,
        status,
        agentMode,
        visibility,
        messageCount: row._count.messages,
        updatedAt: row.updatedAt.toISOString(),
        anchored: row.targetType === targetType && row.targetId === targetId,
        links: linked.filter(link => link.conversationId === row.id).map(({ linkId, kind, auto }) => ({ linkId, kind, auto })),
        ...(wantsArchived ? { archived: true as const, canRestore: true as const, canArchive: true as const } : {}),
      }
    })

    return Response.json({ items, mentionOptions })
  } catch (error) {
    const failure = error as { code?: string; meta?: { column?: string } }
    const missingUnifiedColumn = failure.code === "P2022" && /^(?:agent_conversations|AgentConversation)\.(?:target_type|target_id|status|agent_mode)$/.test(failure.meta?.column ?? "")
    if (!linksLoaded || !missingUnifiedColumn) return Response.json({ error: "Could not load conversations. Please try again." }, { status: 503 })
    const linkedIds = linked.map(link => link.conversationId)
    // Pre-124 fallback: use only linkedIds if migration 124 columns are not present yet.
    if (linkedIds.length === 0 || wantsArchived) return Response.json({ items: [], mentionOptions })
    try {
      const rows = await prisma.agentConversation.findMany({
        where: {
          ...accessWhere,
          archivedAt: null,
          id: { in: linkedIds },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      })
      const items: ObjectConversationSummary[] = rows.map((row) => ({
        id: row.id,
        title: plainTextOf(row.title?.trim() || "Conversation"),
        summary: null,
        status: "OPEN",
        agentMode: "AUTO",
        visibility: "PRIVATE",
        messageCount: row._count.messages,
        updatedAt: row.updatedAt.toISOString(),
        anchored: false,
        links: linked.filter(link => link.conversationId === row.id).map(({ linkId, kind, auto }) => ({ linkId, kind, auto })),
      }))
      return Response.json({ items, mentionOptions })
    } catch {
      return Response.json({ error: "Could not load conversations. Please try again." }, { status: 503 })
    }
  }
}
