import { NextRequest } from "next/server"
import { auth } from "@/auth"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import {
  defaultAgentModeForVisibility,
  isAgentParticipationMode,
  isConversationStatus,
  isConversationVisibility,
  normalizeAgentParticipationMode,
  type AgentParticipationMode,
  type ConversationStatus,
  type ConversationVisibility,
} from "@/lib/agent-participation-mode"

export const runtime = "nodejs"

type Params = { params: Promise<{ id: string }> }

function isMissingColumn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2022"
  )
}

async function resolveTargetLabel(
  prisma: AppPrismaClient,
  workspaceId: string,
  targetType: string | null,
  targetId: string | null,
): Promise<string | null> {
  if (!targetType || !targetId) return null
  try {
    switch (targetType) {
      case "OPPORTUNITY": {
        const row = await prisma.opportunity.findFirst({
          where: { id: targetId, workspaceId },
          select: { title: true },
        })
        return row ? row.title : null
      }
      case "SOLUTION": {
        const row = await prisma.solution.findFirst({
          where: { id: targetId, opportunity: { workspaceId } },
          select: { title: true },
        })
        return row ? row.title : null
      }
      case "TASK": {
        const row = await prisma.task.findFirst({
          where: { id: targetId, workspaceId },
          select: { title: true },
        })
        return row ? row.title : null
      }
      case "ROADMAP_ITEM": {
        const row = await prisma.roadmapItem.findFirst({
          where: { id: targetId, workspaceId },
          select: { title: true },
        })
        return row ? row.title : null
      }
      case "DOC": {
        const row = await prisma.doc.findFirst({
          where: { id: targetId, workspaceId },
          select: { title: true },
        })
        return row ? `DOC · ${row.title}` : null
      }
      default:
        return `${targetType} · ${targetId.slice(0, 8)}`
    }
  } catch {
    return null
  }
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const { id: conversationId } = await params
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")
  if (!workspaceId) return Response.json({ error: "workspaceId is required." }, { status: 400 })

  const prisma = getPrisma()
  const access = await resolveConversationAccess(prisma, {
    conversationId,
    workspaceId,
    userId: session.user.id,
  })
  if (!access) return new Response("Not found", { status: 404 })

  try {
    const row = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        title: true,
        visibility: true,
        status: true,
        agentMode: true,
        targetType: true,
        targetId: true,
        resolvedAt: true,
        resolvedById: true,
      },
    })
    if (!row) return new Response("Not found", { status: 404 })
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
    const targetLabel = await resolveTargetLabel(prisma, workspaceId, row.targetType ?? null, row.targetId ?? null)
    return Response.json({
      id: row.id,
      title: row.title,
      visibility,
      status,
      agentMode,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      targetLabel,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolvedById: row.resolvedById ?? null,
    })
  } catch (error) {
    if (!isMissingColumn(error)) throw error
    return Response.json({
      id: conversationId,
      title: null,
      visibility: "PRIVATE" as const,
      status: "OPEN" as const,
      agentMode: "AUTO" as const,
      targetType: null,
      targetId: null,
      targetLabel: null,
      resolvedAt: null,
      resolvedById: null,
    })
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const { id: conversationId } = await params
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")
  if (!workspaceId) return Response.json({ error: "workspaceId is required." }, { status: 400 })

  const prisma = getPrisma()
  const access = await resolveConversationAccess(prisma, {
    conversationId,
    workspaceId,
    userId: session.user.id,
  })
  if (!access) return new Response("Not found", { status: 404 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const now = new Date()

  try {
    const existing = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: {
        visibility: true,
        status: true,
        agentMode: true,
        targetType: true,
        targetId: true,
      },
    })
    if (!existing) return new Response("Not found", { status: 404 })

    const nextVisibility: ConversationVisibility | undefined = isConversationVisibility(body.visibility)
      ? body.visibility
      : undefined
    const nextStatus: ConversationStatus | undefined = isConversationStatus(body.status)
      ? body.status
      : undefined
    let nextAgentMode: AgentParticipationMode | undefined = isAgentParticipationMode(body.agentMode)
      ? body.agentMode
      : undefined

    // Sharing a private conversation with the workspace automatically switches default AUTO mode to MENTION_ONLY.
    if (
      !nextAgentMode &&
      nextVisibility === "WORKSPACE" &&
      (existing.visibility === "PRIVATE" || existing.visibility === null) &&
      (existing.agentMode === "AUTO" || existing.agentMode === null)
    ) {
      nextAgentMode = "MENTION_ONLY"
    }

    const updated = await prisma.agentConversation.update({
      where: { id: conversationId },
      data: {
        ...(nextVisibility ? { visibility: nextVisibility } : {}),
        ...(nextAgentMode ? { agentMode: nextAgentMode } : {}),
        ...(nextStatus
          ? {
              status: nextStatus,
              resolvedAt: nextStatus === "RESOLVED" ? now : null,
              resolvedById: nextStatus === "RESOLVED" ? session.user.id : null,
            }
          : {}),
        updatedAt: now,
      },
      select: {
        id: true,
        title: true,
        visibility: true,
        status: true,
        agentMode: true,
        targetType: true,
        targetId: true,
        resolvedAt: true,
        resolvedById: true,
      },
    })

    if (nextStatus === "RESOLVED" || nextStatus === "OPEN") {
      await prisma.comment
        .updateMany({
          where: { id: conversationId, workspaceId },
          data: {
            status: nextStatus,
            updatedAt: now,
          },
        })
        .catch(() => {})
    }

    const effectiveVisibility: ConversationVisibility = isConversationVisibility(updated.visibility)
      ? updated.visibility
      : updated.targetType && updated.targetId
        ? "WORKSPACE"
        : "PRIVATE"
    const effectiveStatus: ConversationStatus = isConversationStatus(updated.status)
      ? updated.status
      : "OPEN"
    const effectiveAgentMode: AgentParticipationMode = normalizeAgentParticipationMode(
      updated.agentMode,
      defaultAgentModeForVisibility(effectiveVisibility, Boolean(updated.targetType && updated.targetId)),
    )
    const targetLabel = await resolveTargetLabel(
      prisma,
      workspaceId,
      updated.targetType ?? null,
      updated.targetId ?? null,
    )

    return Response.json({
      id: updated.id,
      title: updated.title,
      visibility: effectiveVisibility,
      status: effectiveStatus,
      agentMode: effectiveAgentMode,
      targetType: updated.targetType ?? null,
      targetId: updated.targetId ?? null,
      targetLabel,
      resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
      resolvedById: updated.resolvedById ?? null,
    })
  } catch (error) {
    if (!isMissingColumn(error)) throw error
    return Response.json({
      id: conversationId,
      title: null,
      visibility: isConversationVisibility(body.visibility) ? body.visibility : "PRIVATE",
      status: isConversationStatus(body.status) ? body.status : "OPEN",
      agentMode: isAgentParticipationMode(body.agentMode) ? body.agentMode : "AUTO",
      targetType: null,
      targetId: null,
      targetLabel: null,
      resolvedAt: null,
      resolvedById: null,
    })
  }
}
