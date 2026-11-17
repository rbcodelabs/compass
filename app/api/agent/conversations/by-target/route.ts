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
} from "@/lib/links/conversation-links"
import { backfillUnifiedConversations } from "@/lib/unified-conversations-backfill"

export const runtime = "nodejs"

export type ObjectConversationSummary = {
  id: string
  title: string
  summary: string | null
  status: ConversationStatus
  agentMode: AgentParticipationMode
  visibility: ConversationVisibility
  messageCount: number
  updatedAt: string
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")
  const targetType = request.nextUrl.searchParams.get("targetType")?.trim().toUpperCase()
  const targetId = request.nextUrl.searchParams.get("targetId")?.trim()
  if (!workspaceId || !targetType || !targetId) {
    return Response.json(
      { error: "workspaceId, targetType, and targetId are required." },
      { status: 400 },
    )
  }

  const userId = session.user.id
  const prisma = getPrisma()

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { userId: true },
  })
  if (!membership) return new Response("Not found", { status: 404 })

  await backfillUnifiedConversations(prisma, { workspaceId, fallbackUserId: userId }).catch(() => {})

  const accessWhere = accessibleConversationsWhere(workspaceId, userId)
  const linked = isConversationLinkTarget(targetType)
    ? await listConversationsForObject(prisma, {
        workspaceId,
        entityType: targetType,
        entityId: targetId,
        userId,
      }).catch(() => [])
    : []
  const linkedIds = linked.map((l) => l.conversationId)

  try {
    const rows = await prisma.agentConversation.findMany({
      where: {
        ...accessWhere,
        archivedAt: null,
        OR: [
          { targetType, targetId },
          ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : []),
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
        title: row.title?.trim() || "Conversation",
        summary: row.summary ?? null,
        status,
        agentMode,
        visibility,
        messageCount: row._count.messages,
        updatedAt: row.updatedAt.toISOString(),
      }
    })

    return Response.json({ items })
  } catch {
    // Pre-124 fallback: use only linkedIds if migration 124 columns are not present yet.
    if (linkedIds.length === 0) return Response.json({ items: [] })
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
      title: row.title?.trim() || "Conversation",
      summary: null,
      status: "OPEN",
      agentMode: "AUTO",
      visibility: "PRIVATE",
      messageCount: row._count.messages,
      updatedAt: row.updatedAt.toISOString(),
    }))
    return Response.json({ items })
  }
}
