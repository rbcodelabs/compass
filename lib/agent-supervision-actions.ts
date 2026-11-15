/**
 * Session-authorized human supervision actions (Phase 6 / PR 6):
 *   - Approve, edit, or discard an AI-proposed reply (`AgentConversationSupervision.proposedReplyText`)
 *   - Answer or dismiss an orchestrator decision (`AgentInboxItem` with `kind = "DECISION"`), routing
 *     the user's decision answer back to `sourceConversationId` (the orchestrator thread)
 *   - Read per-conversation supervision state (`managerNotes`, `proposedReply`, `pendingDecisions`)
 *   - Read and message the user's personal Workspace Orchestrator from `OrchestratorDock`
 *
 * Every read and write is strictly owner-scoped to `(workspaceId, userId)` and tolerates migrations
 * `121`–`123` being unapplied (`P2021` / `P2022`).
 */

import type { AppPrismaClient } from "@/lib/db"
import { authorColumn } from "@/lib/agent-attribution"
import { isMissingTable } from "@/lib/batched-delete"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import {
  startConversationContinuationRun,
  type ContinuationDeps,
  type ContinuationRunOutcome,
} from "@/lib/agent-continuation-run"
import { parseQuestionOptions } from "@/lib/agent-inbox-questions"
import type {
  AgentBoardCardManagerNotes,
  AgentBoardCardPendingDecision,
  AgentBoardCardProposedReply,
} from "@/lib/agent-board"

async function persistSupervisionUserMessage(
  prisma: AppPrismaClient,
  {
    conversationId,
    userId,
    content,
    now,
  }: {
    conversationId: string
    userId: string
    content: string
    now: Date
  },
): Promise<string> {
  const authorData = await authorColumn(prisma, userId)
  const saved = await prisma.agentMessage.create({
    data: {
      conversationId,
      role: "user",
      content,
      createdAt: now,
      ...authorData,
    },
    select: { id: true },
  })
  await prisma.agentConversation
    .update({ where: { id: conversationId }, data: { updatedAt: now }, select: { id: true } })
    .catch(() => {})
  return saved.id
}

export class AgentSupervisionError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "AgentSupervisionError"
    this.status = status
    this.code = code
  }
}

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2022"
}

export type ConversationSupervisionState = {
  managerNotes: AgentBoardCardManagerNotes | null
  proposedReply: AgentBoardCardProposedReply | null
  pendingDecisions: AgentBoardCardPendingDecision[]
}

export async function getConversationSupervisionState(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string },
): Promise<ConversationSupervisionState> {
  const access = await resolveConversationAccess(prisma, input)
  if (!access) {
    throw new AgentSupervisionError("Conversation not found.", 404, "CONVERSATION_NOT_FOUND")
  }

  let managerNotes: AgentBoardCardManagerNotes | null = null
  let proposedReply: AgentBoardCardProposedReply | null = null
  try {
    const sup = await prisma.agentConversationSupervision.findUnique({
      where: {
        conversationId_supervisorUserId: {
          conversationId: input.conversationId,
          supervisorUserId: input.userId,
        },
      },
      select: {
        managerNotes: true,
        managerNotesUpdatedAt: true,
        managerSourceOrchestratorId: true,
        proposedReplyText: true,
        proposedReplyGeneratedAt: true,
        proposedReplyAuthorOrchestratorId: true,
      },
    })
    if (sup) {
      const notesText = sup.managerNotes?.trim()
      const replyText = sup.proposedReplyText?.trim()
      if (notesText) {
        managerNotes = {
          text: notesText,
          updatedAt: sup.managerNotesUpdatedAt ? sup.managerNotesUpdatedAt.toISOString() : null,
          sourceOrchestratorId: sup.managerSourceOrchestratorId ?? null,
        }
      }
      if (replyText) {
        proposedReply = {
          text: replyText,
          generatedAt: sup.proposedReplyGeneratedAt ? sup.proposedReplyGeneratedAt.toISOString() : null,
          authorOrchestratorId: sup.proposedReplyAuthorOrchestratorId ?? null,
        }
      }
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  let pendingDecisions: AgentBoardCardPendingDecision[] = []
  try {
    const rows = await prisma.agentInboxItem.findMany({
      where: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        recipientUserId: input.userId,
        kind: "DECISION",
        status: "PENDING",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        conversationId: true,
        sourceConversationId: true,
        header: true,
        question: true,
        optionsJson: true,
        multiSelect: true,
        allowOther: true,
        status: true,
        answerText: true,
        createdAt: true,
      },
    })
    pendingDecisions = rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      sourceConversationId: row.sourceConversationId ?? null,
      header: row.header ?? null,
      question: row.question,
      options: parseQuestionOptions(row.optionsJson),
      multiSelect: row.multiSelect,
      allowOther: row.allowOther,
      status: "PENDING",
      answerText: row.answerText ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  return { managerNotes, proposedReply, pendingDecisions }
}

export type ApproveProposedReplyResult = {
  ok: true
  conversationId: string
  text: string
  runId: string | null
  continuation: ContinuationRunOutcome
}

export async function approveProposedReply({
  prisma,
  workspaceId,
  conversationId,
  userId,
  overrideText,
  now = new Date(),
  continuationDeps,
}: {
  prisma: AppPrismaClient
  workspaceId: string
  conversationId: string
  userId: string
  overrideText?: string | null
  now?: Date
  continuationDeps?: Partial<ContinuationDeps>
}): Promise<ApproveProposedReplyResult> {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) {
    throw new AgentSupervisionError("Conversation not found.", 404, "CONVERSATION_NOT_FOUND")
  }

  let storedText: string | null = null
  try {
    const sup = await prisma.agentConversationSupervision.findUnique({
      where: {
        conversationId_supervisorUserId: {
          conversationId,
          supervisorUserId: userId,
        },
      },
      select: { proposedReplyText: true },
    })
    storedText = sup?.proposedReplyText?.trim() ?? null
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  const finalText = overrideText?.trim() || storedText
  if (!finalText) {
    throw new AgentSupervisionError(
      "No proposed reply is currently staged on this conversation.",
      409,
      "NO_PROPOSED_REPLY",
    )
  }

  try {
    await prisma.agentConversationSupervision.updateMany({
      where: { conversationId, workspaceId, supervisorUserId: userId },
      data: {
        proposedReplyText: null,
        proposedReplyGeneratedAt: null,
        proposedReplyAuthorOrchestratorId: null,
        updatedAt: now,
      },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  try {
    await prisma.agentInboxItem.updateMany({
      where: {
        workspaceId,
        conversationId,
        recipientUserId: userId,
        kind: "PROPOSED_REPLY",
        status: "PENDING",
      },
      data: {
        status: "ANSWERED",
        answerText: finalText,
        resolvedByUserId: userId,
        resolvedAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  const existingUserMessageId = await persistSupervisionUserMessage(prisma, {
    conversationId,
    userId,
    content: finalText,
    now,
  })

  const continuation = await startConversationContinuationRun(
    {
      workspaceId,
      conversationId,
      userId,
      message: finalText,
      existingUserMessageId,
      deferLaunch: true,
    },
    continuationDeps,
  )

  return {
    ok: true,
    conversationId,
    text: finalText,
    runId:
      continuation.status === "started"
        ? continuation.runId
        : continuation.status === "already_running"
          ? (continuation.runId ?? null)
          : null,
    continuation,
  }
}

export async function discardProposedReply({
  prisma,
  workspaceId,
  conversationId,
  userId,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  workspaceId: string
  conversationId: string
  userId: string
  now?: Date
}): Promise<{ ok: true; conversationId: string }> {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) {
    throw new AgentSupervisionError("Conversation not found.", 404, "CONVERSATION_NOT_FOUND")
  }

  try {
    await prisma.agentConversationSupervision.updateMany({
      where: { conversationId, workspaceId, supervisorUserId: userId },
      data: {
        proposedReplyText: null,
        proposedReplyGeneratedAt: null,
        proposedReplyAuthorOrchestratorId: null,
        updatedAt: now,
      },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  try {
    await prisma.agentInboxItem.updateMany({
      where: {
        workspaceId,
        conversationId,
        recipientUserId: userId,
        kind: "PROPOSED_REPLY",
        status: "PENDING",
      },
      data: {
        status: "CLEARED",
        resolvedByUserId: userId,
        resolvedAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  return { ok: true, conversationId }
}

export type AnswerDecisionResult = {
  ok: true
  itemId: string
  conversationId: string
  targetConversationId: string
  formattedMessage: string
  runId: string | null
  continuation?: ContinuationRunOutcome
}

export async function answerAgentDecision({
  prisma,
  itemId,
  userId,
  answerText,
  now = new Date(),
  continuationDeps,
}: {
  prisma: AppPrismaClient
  itemId: string
  userId: string
  answerText: string
  now?: Date
  continuationDeps?: Partial<ContinuationDeps>
}): Promise<AnswerDecisionResult> {
  const cleanAnswer = answerText.trim()
  if (!cleanAnswer) {
    throw new AgentSupervisionError("Decision answer is required.", 400, "EMPTY_ANSWER")
  }
  if (cleanAnswer.length > 4_000) {
    throw new AgentSupervisionError("Decision answer must be 4,000 characters or fewer.", 400, "ANSWER_TOO_LONG")
  }

  let item: {
    id: string
    workspaceId: string
    conversationId: string
    recipientUserId: string | null
    sourceConversationId: string | null
    kind: string
    header: string | null
    question: string
    status: string
  } | null = null

  try {
    item = await prisma.agentInboxItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        recipientUserId: true,
        sourceConversationId: true,
        kind: true,
        header: true,
        question: true,
        status: true,
      },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
    }
    throw error
  }

  if (!item || item.kind !== "DECISION" || (item.recipientUserId && item.recipientUserId !== userId)) {
    throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
  }

  const access = await resolveConversationAccess(prisma, {
    conversationId: item.conversationId,
    workspaceId: item.workspaceId,
    userId,
  })
  if (!access) {
    throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
  }

  const claimed = await prisma.agentInboxItem.updateMany({
    where: { id: item.id, status: "PENDING" },
    data: {
      status: "ANSWERED",
      answerText: cleanAnswer,
      resolvedByUserId: userId,
      resolvedAt: now,
      updatedAt: now,
    },
  })
  if (claimed.count !== 1) {
    throw new AgentSupervisionError("This decision has already been answered or dismissed.", 409, "DECISION_ALREADY_RESOLVED")
  }

  await prisma.agentConversation
    .update({ where: { id: item.conversationId }, data: { updatedAt: now }, select: { id: true } })
    .catch(() => {})

  const headerPart = item.header ? `${item.header} ` : ""
  const formattedMessage = `Decision ${headerPart}[${item.id}]: ${cleanAnswer}`
  const targetConversationId = item.sourceConversationId ?? item.conversationId

  // Verify the caller can also access targetConversationId; fall back to item.conversationId if deleted.
  const targetAccess =
    targetConversationId === item.conversationId
      ? access
      : await resolveConversationAccess(prisma, {
          conversationId: targetConversationId,
          workspaceId: item.workspaceId,
          userId,
        })
  const dispatchConversationId = targetAccess ? targetConversationId : item.conversationId
  const existingUserMessageId = await persistSupervisionUserMessage(prisma, {
    conversationId: dispatchConversationId,
    userId,
    content: formattedMessage,
    now,
  })

  const continuation = await startConversationContinuationRun(
    {
      workspaceId: item.workspaceId,
      conversationId: dispatchConversationId,
      userId,
      message: formattedMessage,
      existingUserMessageId,
      deferLaunch: true,
    },
    continuationDeps,
  )

  return {
    ok: true,
    itemId: item.id,
    conversationId: item.conversationId,
    targetConversationId: dispatchConversationId,
    formattedMessage,
    runId:
      continuation.status === "started"
        ? continuation.runId
        : continuation.status === "already_running"
          ? (continuation.runId ?? null)
          : null,
    continuation,
  }
}

export async function dismissAgentDecision({
  prisma,
  itemId,
  userId,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  itemId: string
  userId: string
  now?: Date
}): Promise<{ ok: true; itemId: string; conversationId: string }> {
  let item: {
    id: string
    workspaceId: string
    conversationId: string
    recipientUserId: string | null
    kind: string
  } | null = null
  try {
    item = await prisma.agentInboxItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        recipientUserId: true,
        kind: true,
      },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
    }
    throw error
  }

  if (!item || item.kind !== "DECISION" || (item.recipientUserId && item.recipientUserId !== userId)) {
    throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
  }

  const access = await resolveConversationAccess(prisma, {
    conversationId: item.conversationId,
    workspaceId: item.workspaceId,
    userId,
  })
  if (!access) {
    throw new AgentSupervisionError("Decision not found.", 404, "DECISION_NOT_FOUND")
  }

  await prisma.agentInboxItem.updateMany({
    where: { id: item.id, status: "PENDING" },
    data: {
      status: "CLEARED",
      resolvedByUserId: userId,
      resolvedAt: now,
      updatedAt: now,
    },
  })

  return { ok: true, itemId: item.id, conversationId: item.conversationId }
}

export type OrchestratorDockMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
}

export type OrchestratorDockState = {
  orchestratorId: string | null
  conversationId: string | null
  title: string
  enabled: boolean
  runStatus: string | null
  currentActivity: string | null
  messages: OrchestratorDockMessage[]
}

export async function getOrchestratorDockState(
  prisma: AppPrismaClient,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<OrchestratorDockState> {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  })
  if (!member) {
    throw new AgentSupervisionError("Workspace not found.", 404, "WORKSPACE_NOT_FOUND")
  }

  try {
    const orch = await prisma.agentOrchestrator.findUnique({
      where: {
        userId_workspaceId_scopeType_scopeKey: {
          userId,
          workspaceId,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
        },
      },
      select: {
        id: true,
        conversationId: true,
        enabled: true,
      },
    })

    if (!orch?.conversationId) {
      return {
        orchestratorId: orch?.id ?? null,
        conversationId: null,
        title: "Workspace Orchestrator",
        enabled: orch?.enabled ?? false,
        runStatus: null,
        currentActivity: null,
        messages: [],
      }
    }

    const [conv, rawMessages] = await Promise.all([
      prisma.agentConversation.findFirst({
        where: { id: orch.conversationId, workspaceId, userId },
        select: {
          id: true,
          title: true,
          runs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              status: true,
              currentActivity: true,
            },
          },
        },
      }),
      prisma.agentMessage.findMany({
        where: { conversationId: orch.conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
        },
      }),
    ])

    const latestRun = conv?.runs[0] ?? null
    const messages: OrchestratorDockMessage[] = rawMessages
      .reverse()
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0)
      .map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }))

    return {
      orchestratorId: orch.id,
      conversationId: orch.conversationId,
      title: conv?.title || "Workspace Orchestrator",
      enabled: orch.enabled,
      runStatus: latestRun?.status ?? null,
      currentActivity:
        latestRun && (latestRun.status === "QUEUED" || latestRun.status === "RUNNING")
          ? (latestRun.currentActivity ?? null)
          : null,
      messages,
    }
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      return {
        orchestratorId: null,
        conversationId: null,
        title: "Workspace Orchestrator",
        enabled: false,
        runStatus: null,
        currentActivity: null,
        messages: [],
      }
    }
    throw error
  }
}

export async function sendOrchestratorDockMessage({
  prisma,
  workspaceId,
  userId,
  message,
  now = new Date(),
  continuationDeps,
}: {
  prisma: AppPrismaClient
  workspaceId: string
  userId: string
  message: string
  now?: Date
  continuationDeps?: Partial<ContinuationDeps>
}): Promise<{
  ok: true
  orchestratorId: string
  conversationId: string
  runId: string | null
  continuation: ContinuationRunOutcome
}> {
  const cleanMessage = message.trim()
  if (!cleanMessage) {
    throw new AgentSupervisionError("Message is required.", 400, "EMPTY_MESSAGE")
  }
  if (cleanMessage.length > 8_000) {
    throw new AgentSupervisionError("Message must be 8,000 characters or fewer.", 400, "MESSAGE_TOO_LONG")
  }

  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  })
  if (!member) {
    throw new AgentSupervisionError("Workspace not found.", 404, "WORKSPACE_NOT_FOUND")
  }

  try {
    let existing = await prisma.agentOrchestrator.findUnique({
      where: {
        userId_workspaceId_scopeType_scopeKey: {
          userId,
          workspaceId,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
        },
      },
      select: { id: true, conversationId: true },
    })

    let conversationId = existing?.conversationId ?? null
    if (conversationId) {
      const convExists = await prisma.agentConversation.findFirst({
        where: { id: conversationId, workspaceId, userId },
        select: { id: true },
      })
      if (!convExists) conversationId = null
    }

    if (!conversationId) {
      const conv = await prisma.agentConversation.create({
        data: {
          workspaceId,
          userId,
          title: "Workspace Orchestrator",
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      conversationId = conv.id
    }

    existing = await prisma.agentOrchestrator.upsert({
      where: {
        userId_workspaceId_scopeType_scopeKey: {
          userId,
          workspaceId,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
        },
      },
      create: {
        workspaceId,
        userId,
        scopeType: "WORKSPACE",
        scopeKey: "workspace",
        conversationId,
        enabled: true,
        wakeOnActivity: true,
        heartbeatEnabled: true,
        heartbeatMinutes: 60,
        escalationsEnabled: true,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        conversationId,
        enabled: true,
        updatedAt: now,
      },
      select: { id: true, conversationId: true },
    })

    const existingUserMessageId = await persistSupervisionUserMessage(prisma, {
      conversationId,
      userId,
      content: cleanMessage,
      now,
    })

    const continuation = await startConversationContinuationRun(
      {
        workspaceId,
        conversationId,
        userId,
        message: cleanMessage,
        existingUserMessageId,
        deferLaunch: true,
      },
      continuationDeps,
    )

    return {
      ok: true,
      orchestratorId: existing.id,
      conversationId,
      runId:
        continuation.status === "started"
          ? continuation.runId
          : continuation.status === "already_running"
            ? (continuation.runId ?? null)
            : null,
      continuation,
    }
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      throw new AgentSupervisionError(
        "Workspace Orchestrator requires migration 122_agent_orchestrator_supervision.",
        503,
        "ORCHESTRATOR_UNAVAILABLE",
      )
    }
    throw error
  }
}
