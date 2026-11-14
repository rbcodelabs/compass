/**
 * Server-side data for the agent board: the card list, rich metadata batching, workspace
 * squads, and the per-user "reviewed" write.
 *
 * The reviewed flag is per USER, not per conversation: a shared conversation (participants)
 * has one row per person who has opened it, so one person's review never marks another's
 * board. Both the read and the write go through lib/agent-conversation-access.ts, the same
 * predicate the chat uses, so the board can never show or mark a conversation the chat
 * would refuse (including after the caller leaves the workspace).
 *
 * Tolerates both migration 109 (reviews table) and migration 119 (rich card columns) being
 * unapplied so deploying code before `/api/admin/migrate` runs never breaks `/agent`.
 */

import type { AppPrismaClient } from "@/lib/db"
import { isMissingTable } from "@/lib/batched-delete"
import { accessibleConversationsWhere, resolveConversationAccess } from "@/lib/agent-conversation-access"
import { deriveConversationSummary, extractLatestPrUrl } from "@/lib/agent-card-derive"
import { toAgentStatus } from "@/lib/agent-task-tools"
import { getTasksLinkedToOrigin } from "@/lib/task-links-read"
import { resolveEndpoints } from "@/lib/links/endpoints"
import { listLinkRowsFromEntities } from "@/lib/links/service"
import {
  CONVERSATION_CREATED_LINK_TYPE,
  CONVERSATION_LINK_TARGET_TYPES,
  CONVERSATION_MENTIONS_LINK_TYPE,
} from "@/lib/links/registry"
import {
  MAX_CARD_LINKED_OBJECTS,
  MAX_CARD_SUBTASK_ITEMS,
  type AgentBoardCard,
  type AgentBoardCardLinkedObject,
  type AgentBoardCardSquad,
  type AgentBoardCardSubtasks,
} from "@/lib/agent-board"
import { loadChildAgentSummariesByConversation } from "@/lib/agent-child-runs"
import { loadPendingQuestionsByConversation } from "@/lib/agent-inbox-questions"
import { loadScheduledWakeupsByConversation } from "@/lib/agent-scheduled-wakeups"

type BoardDb = Pick<AppPrismaClient, "agentConversation" | "agentConversationReview"> &
  Partial<
    Pick<
      AppPrismaClient,
      | "task"
      | "squad"
      | "agentMessage"
      | "agentChildRun"
      | "agentInboxItem"
      | "agentScheduledWakeup"
    >
  >

/** Enough for any realistic workspace; the board is a triage surface, not an archive. */
const BOARD_LIMIT = 100
const LINK_BATCH_CAP = 500

function isMissingColumn(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2022"
}

type RawBoardConversation = {
  id: string
  title: string | null
  updatedAt: Date
  squadId?: string | null
  summary?: string | null
  prUrl?: string | null
  _count: { messages: number }
  runs: {
    status: string
    statusChangedAt: Date
    substatus?: string | null
    currentActivity?: string | null
    lastHeartbeatAt?: Date | null
  }[]
}

async function queryBoardConversations(
  prisma: BoardDb,
  workspaceId: string,
  userId: string,
): Promise<RawBoardConversation[]> {
  const where = accessibleConversationsWhere(workspaceId, userId)
  try {
    return (await prisma.agentConversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: BOARD_LIMIT,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        squadId: true,
        summary: true,
        prUrl: true,
        _count: { select: { messages: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            substatus: true,
            currentActivity: true,
            lastHeartbeatAt: true,
            statusChangedAt: true,
          },
        },
      },
    })) as RawBoardConversation[]
  } catch (error) {
    if (!isMissingColumn(error)) throw error
    // Pre-119 fallback: select only columns guaranteed to exist before 119_agent_board_rich_cards runs.
    return (await prisma.agentConversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: BOARD_LIMIT,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        _count: { select: { messages: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            lastHeartbeatAt: true,
            statusChangedAt: true,
          },
        },
      },
    })) as RawBoardConversation[]
  }
}

async function loadSubtasksByConversation(
  prisma: BoardDb,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<{ subtasksByConv: Map<string, AgentBoardCardSubtasks>; planTaskIdsByConv: Map<string, Set<string>> }> {
  const subtasksByConv = new Map<string, AgentBoardCardSubtasks>()
  const planTaskIdsByConv = new Map<string, Set<string>>()
  if (!prisma.task || conversationIds.length === 0) {
    return { subtasksByConv, planTaskIdsByConv }
  }

  try {
    const originLinks = await getTasksLinkedToOrigin(prisma as AppPrismaClient, {
      workspaceId,
      linkedType: "AGENT_CONVERSATION",
      linkedIds: conversationIds,
    })
    if (originLinks.length === 0) return { subtasksByConv, planTaskIdsByConv }

    const uniqueTaskIds = [...new Set(originLinks.map((link) => link.taskId))]
    const tasks = await prisma.task.findMany({
      where: { workspaceId, status: { not: "CANCELLED" }, id: { in: uniqueTaskIds } },
      select: { id: true, title: true, status: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    })
    const taskOrder = new Map(tasks.map((task, idx) => [task.id, { task, idx }]))

    const grouped = new Map<string, { id: string; title: string; status: "pending" | "in_progress" | "completed"; idx: number }[]>()
    for (const link of originLinks) {
      let planSet = planTaskIdsByConv.get(link.linkedId)
      if (!planSet) {
        planSet = new Set()
        planTaskIdsByConv.set(link.linkedId, planSet)
      }
      planSet.add(link.taskId)

      const entry = taskOrder.get(link.taskId)
      if (!entry) continue
      const list = grouped.get(link.linkedId) ?? []
      if (!list.some((item) => item.id === entry.task.id)) {
        list.push({
          id: entry.task.id,
          title: entry.task.title,
          status: toAgentStatus(entry.task.status),
          idx: entry.idx,
        })
        grouped.set(link.linkedId, list)
      }
    }

    for (const [conversationId, list] of grouped) {
      list.sort((a, b) => a.idx - b.idx)
      const completed = list.filter((item) => item.status === "completed").length
      subtasksByConv.set(conversationId, {
        completed,
        total: list.length,
        items: list.slice(0, MAX_CARD_SUBTASK_ITEMS).map(({ id, title, status }) => ({ id, title, status })),
      })
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }

  return { subtasksByConv, planTaskIdsByConv }
}

async function loadLinkedObjectsByConversation(
  prisma: BoardDb,
  workspaceId: string,
  conversationIds: readonly string[],
  planTaskIdsByConv: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Map<string, { items: AgentBoardCardLinkedObject[]; total: number }>> {
  const result = new Map<string, { items: AgentBoardCardLinkedObject[]; total: number }>()
  if (conversationIds.length === 0) return result

  try {
    const rows = await listLinkRowsFromEntities(prisma as Partial<AppPrismaClient>, {
      workspaceId,
      linkTypes: [CONVERSATION_CREATED_LINK_TYPE, CONVERSATION_MENTIONS_LINK_TYPE],
      fromIds: conversationIds,
      take: LINK_BATCH_CAP,
    })
    if (rows.length === 0) return result

    const filtered = rows.filter((row) => {
      if (row.toType === "TASK" && planTaskIdsByConv.get(row.fromId)?.has(row.toId)) return false
      return (CONVERSATION_LINK_TARGET_TYPES as readonly string[]).includes(row.toType)
    })
    if (filtered.length === 0) return result

    const titles = new Map<string, string>()
    await Promise.all(
      CONVERSATION_LINK_TARGET_TYPES.map(async (type) => {
        const ids = [...new Set(filtered.filter((row) => row.toType === type).map((row) => row.toId))]
        if (ids.length === 0) return
        const resolved = await resolveEndpoints(prisma as AppPrismaClient, type, workspaceId, ids)
        for (const [id, endpoint] of resolved) titles.set(`${type}:${id}`, endpoint.title)
      }),
    )

    const grouped = new Map<string, (AgentBoardCardLinkedObject & { at: number })[]>()
    for (const row of filtered) {
      const title = titles.get(`${row.toType}:${row.toId}`)
      if (title === undefined) continue
      const kind = row.linkType === CONVERSATION_CREATED_LINK_TYPE ? ("CREATED" as const) : ("MENTIONS" as const)
      const entityType = row.toType as AgentBoardCardLinkedObject["entityType"]
      const list = grouped.get(row.fromId) ?? []
      if (!list.some((item) => item.entityType === entityType && item.entityId === row.toId)) {
        list.push({ entityType, entityId: row.toId, title, kind, at: row.createdAt.getTime() })
        grouped.set(row.fromId, list)
      }
    }

    for (const [conversationId, list] of grouped) {
      list.sort((a, b) => (a.kind === b.kind ? a.at - b.at : a.kind === "CREATED" ? -1 : 1))
      result.set(conversationId, {
        total: list.length,
        items: list.slice(0, MAX_CARD_LINKED_OBJECTS).map(({ entityType, entityId, title, kind }) => ({
          entityType,
          entityId,
          title,
          kind,
        })),
      })
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }

  return result
}

async function loadSquadsById(
  prisma: BoardDb,
  workspaceId: string,
  squadIds: readonly string[],
): Promise<Map<string, AgentBoardCardSquad>> {
  const byId = new Map<string, AgentBoardCardSquad>()
  if (!prisma.squad || squadIds.length === 0) return byId
  const rows = await prisma.squad.findMany({
    where: { workspaceId, id: { in: [...squadIds] } },
    select: { id: true, name: true, color: true },
  })
  for (const row of rows) byId.set(row.id, { id: row.id, name: row.name, color: row.color })
  return byId
}

/**
 * Fallback summary + PR extraction for conversations that already had assistant messages
 * before migration 119 added `agent_conversations.summary` / `pr_url`.
 */
async function loadFallbackAssistantExcerpts(
  prisma: BoardDb,
  conversationIds: readonly string[],
): Promise<Map<string, { summary: string | null; prUrl: string | null }>> {
  const result = new Map<string, { summary: string | null; prUrl: string | null }>()
  if (!prisma.agentMessage || conversationIds.length === 0) return result
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId: { in: [...conversationIds] }, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { conversationId: true, content: true },
    take: Math.min(conversationIds.length * 3, 250),
  })
  for (const row of rows) {
    if (result.has(row.conversationId)) continue
    result.set(row.conversationId, {
      summary: deriveConversationSummary(row.content),
      prUrl: extractLatestPrUrl(row.content),
    })
  }
  return result
}

export async function listWorkspaceBoardSquads(
  prisma: Pick<AppPrismaClient, "squad" | "workspaceMember">,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<AgentBoardCardSquad[]> {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  })
  if (!member) return []
  const squads = await prisma.squad.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: { id: true, name: true, color: true },
  })
  return squads.map((s) => ({ id: s.id, name: s.name, color: s.color }))
}

export async function listAgentBoardCards(
  prisma: BoardDb,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<AgentBoardCard[]> {
  const conversations = await queryBoardConversations(prisma, workspaceId, userId)
  if (conversations.length === 0) return []

  const conversationIds = conversations.map((c) => c.id)
  const referencedSquadIds = [...new Set(conversations.map((c) => c.squadId).filter((id): id is string => Boolean(id)))]
  const missingSummaryIds = conversations
    .filter((c) => c._count.messages > 0 && !c.summary)
    .map((c) => c.id)

  const [
    reviewedAt,
    subtaskData,
    squadsById,
    fallbackExcerpts,
    childAgentsByConv,
    pendingQuestionsByConv,
    scheduledWakeupsByConv,
  ] = await Promise.all([
    (async () => {
      try {
        const reviews = await prisma.agentConversationReview.findMany({
          // The caller's rows only: another participant's review is never visible here.
          where: { userId, workspaceId, conversationId: { in: conversationIds } },
          select: { conversationId: true, reviewedAt: true },
        })
        return new Map(reviews.map((r) => [r.conversationId, r.reviewedAt]))
      } catch (error) {
        if (!isMissingTable(error)) throw error
        return new Map<string, Date>()
      }
    })(),
    loadSubtasksByConversation(prisma, workspaceId, conversationIds),
    loadSquadsById(prisma, workspaceId, referencedSquadIds),
    loadFallbackAssistantExcerpts(prisma, missingSummaryIds),
    loadChildAgentSummariesByConversation(prisma, workspaceId, conversationIds),
    loadPendingQuestionsByConversation(prisma, workspaceId, conversationIds),
    loadScheduledWakeupsByConversation(prisma, workspaceId, conversationIds),
  ])

  const linkedByConv = await loadLinkedObjectsByConversation(
    prisma,
    workspaceId,
    conversationIds,
    subtaskData.planTaskIdsByConv,
  )

  return conversations.map((c) => {
    const run = c.runs[0] ?? null
    const lastActivity = run && run.statusChangedAt > c.updatedAt ? run.statusChangedAt : c.updatedAt
    const squad = c.squadId ? (squadsById.get(c.squadId) ?? null) : null
    const fallback = fallbackExcerpts.get(c.id)
    const summary = c.summary ?? fallback?.summary ?? null
    const prUrl = c.prUrl ?? fallback?.prUrl ?? null
    const substatus = run && (run.status === "QUEUED" || run.status === "RUNNING") ? (run.substatus ?? null) : null
    const currentActivity = run && (run.status === "QUEUED" || run.status === "RUNNING") ? (run.currentActivity ?? null) : null
    const lastHeartbeatAt = run && run.status === "RUNNING" && run.lastHeartbeatAt ? run.lastHeartbeatAt.toISOString() : null
    const subtasks = subtaskData.subtasksByConv.get(c.id)
    const linked = linkedByConv.get(c.id)
    const childAgents = childAgentsByConv.get(c.id)
    const pendingQuestions = pendingQuestionsByConv.get(c.id)
    const scheduledWakeup = scheduledWakeupsByConv.get(c.id) ?? null

    return {
      id: c.id,
      title: c.title,
      messageCount: c._count.messages,
      runStatus: run?.status ?? null,
      lastActivityAt: lastActivity.toISOString(),
      reviewedAt: reviewedAt.get(c.id)?.toISOString() ?? null,
      ...(squad ? { squad } : {}),
      ...(summary ? { summary } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(substatus ? { substatus } : {}),
      ...(currentActivity ? { currentActivity } : {}),
      ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
      ...(subtasks && subtasks.total > 0 ? { subtasks } : {}),
      ...(linked && linked.total > 0 ? { linkedObjects: linked.items, linkedObjectCount: linked.total } : {}),
      ...(childAgents && childAgents.total > 0 ? { childAgents } : {}),
      ...(pendingQuestions && pendingQuestions.length > 0 ? { pendingQuestions } : {}),
      ...(scheduledWakeup ? { scheduledWakeup } : {}),
    }
  })
}

export type MarkReviewedResult = { ok: true } | { ok: false; reason: "not_found" | "unavailable" }

/** Records that `userId` has looked at a conversation as of `now`. "not_found" covers both missing and not-yours. */
export async function markConversationReviewed(
  prisma: BoardDb,
  { conversationId, workspaceId, userId, now = new Date() }: { conversationId: string; workspaceId: string; userId: string; now?: Date },
): Promise<MarkReviewedResult> {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) return { ok: false, reason: "not_found" }
  try {
    await prisma.agentConversationReview.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, workspaceId, userId, reviewedAt: now, createdAt: now, updatedAt: now },
      update: { reviewedAt: now, updatedAt: now },
    })
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002") {
      await prisma.agentConversationReview.updateMany({
        where: { conversationId, userId, workspaceId },
        data: { reviewedAt: now, updatedAt: now },
      })
      return { ok: true }
    }
    if (isMissingTable(error)) return { ok: false, reason: "unavailable" }
    throw error
  }
  return { ok: true }
}

/**
 * Removes every review row in a workspace. Workspace deletion calls this before it deletes the conversations the
 * rows point at (relationMode "prisma" enforces nothing in the database, so nothing cascades). Tolerates the
 * reviews migration being unapplied, so a deployment that has not applied it can still delete a workspace.
 */
export async function deleteWorkspaceConversationReviews(
  prisma: Pick<AppPrismaClient, "agentConversationReview">,
  workspaceId: string,
): Promise<void> {
  try {
    await prisma.agentConversationReview.deleteMany({ where: { workspaceId } })
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }
}
