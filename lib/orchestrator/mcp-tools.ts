/**
 * Thread Coordination & Orchestrator MCP Tool Suite (`lib/orchestrator/mcp-tools.ts`, migration 122).
 *
 * Contributes the 17 `AGENT_TURN`-scoped coordination tools to `/api/mcp`:
 * - Discovery: `threads_get_current`, `threads_list`, `threads_get_messages`, `threads_get_log`,
 *   `threads_list_squads`, `threads_set_squad`
 * - Delegation: `threads_create`, `threads_send_message`, `threads_wait`, `threads_archive`
 * - Supervision: `threads_set_notes`, `threads_set_proposed_reply`, `threads_clear_proposed_reply`,
 *   `threads_post_decision`, `threads_clear_decision`
 * - Escalation & Admin: `notify_workspace_orchestrator`, `threads_list_orchestrators`,
 *   `threads_set_orchestrator_enabled`
 */

import { z } from "zod"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { isMissingTable } from "@/lib/batched-delete"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { findActiveAgentRun } from "@/lib/agent-runs"
import {
  startConversationContinuationRun,
  type ContinuationRunOutcome,
} from "@/lib/agent-continuation-run"
import {
  DESTINATION_OUTSIDE_SCOPE_MESSAGE,
  OUTSIDE_COORDINATION_SCOPE_MESSAGE,
  evaluateSendMessageGuard,
  evaluateSquadDestinationAccess,
  evaluateThreadCoordinationAccess,
  isValidUuid,
  requireAuthorizedTargetConversation,
  resolveCallingThreadContext,
  type CallingThreadContext,
} from "@/lib/orchestrator/scope"

export const ORCHESTRATOR_READ_TOOLS = [
  "threads_get_current",
  "threads_list",
  "threads_get_messages",
  "threads_get_log",
  "threads_list_squads",
  "threads_wait",
  "threads_list_orchestrators",
] as const

export const ORCHESTRATOR_WRITE_TOOLS = [
  "threads_set_squad",
  "threads_create",
  "threads_send_message",
  "threads_archive",
  "threads_set_notes",
  "threads_set_proposed_reply",
  "threads_clear_proposed_reply",
  "threads_post_decision",
  "threads_clear_decision",
  "notify_workspace_orchestrator",
  "threads_set_orchestrator_enabled",
] as const

export const ALL_ORCHESTRATOR_MCP_TOOLS = [
  ...ORCHESTRATOR_READ_TOOLS,
  ...ORCHESTRATOR_WRITE_TOOLS,
] as const

export const NOTIFY_WORKSPACE_KINDS = [
  "error",
  "needs_you",
  "pr_ready",
  "release",
  "blocked",
  "lost_thread",
] as const
export type NotifyWorkspaceKind = (typeof NOTIFY_WORKSPACE_KINDS)[number]

export const ESCALATION_MAX_SUMMARY_CHARS = 400
export const ESCALATION_MAX_SHORT_FIELD_CHARS = 200
export const ESCALATION_BURST = 3
export const ESCALATION_REFILL_MS = 5 * 60_000
export const ESCALATION_DEDUPE_WINDOW_MS = 30 * 60_000
export const WAITING_THREADS_SUBSTATUS = "WAITING_THREADS"
export const WORKSPACE_ORCHESTRATOR_ONLY_MESSAGE =
  "Only the Workspace orchestrator can manage Squad orchestrators."

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  const code = (error as { code?: unknown })?.code
  return code === "P2022" || code === "42703"
}

export function clampSingleLine(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat
}

export interface EscalationState {
  creditMs: number
  updatedAtMs: number
  sentByKey: Record<string, number>
}

export function parseEscalationState(rawJson: string | null | undefined, nowMs: number): EscalationState {
  const maxCredit = ESCALATION_BURST * ESCALATION_REFILL_MS
  if (!rawJson) {
    return { creditMs: maxCredit, updatedAtMs: nowMs, sentByKey: {} }
  }
  try {
    const parsed = JSON.parse(rawJson) as Partial<EscalationState>
    const creditMs =
      typeof parsed.creditMs === "number" && Number.isFinite(parsed.creditMs)
        ? Math.max(0, Math.min(maxCredit, parsed.creditMs))
        : maxCredit
    const updatedAtMs =
      typeof parsed.updatedAtMs === "number" && Number.isFinite(parsed.updatedAtMs)
        ? parsed.updatedAtMs
        : nowMs
    const sentByKey: Record<string, number> = {}
    if (parsed.sentByKey && typeof parsed.sentByKey === "object") {
      for (const [k, v] of Object.entries(parsed.sentByKey)) {
        if (typeof v === "number" && Number.isFinite(v) && nowMs - v < ESCALATION_DEDUPE_WINDOW_MS) {
          sentByKey[k] = v
        }
      }
    }
    return { creditMs, updatedAtMs, sentByKey }
  } catch {
    return { creditMs: maxCredit, updatedAtMs: nowMs, sentByKey: {} }
  }
}

/**
 * Pure token-bucket (1 msg / 5m, burst 3) + 30m `(kind, subject)` deduplication evaluator.
 */
export function evaluateAndAdvanceEscalationState(
  rawStateJson: string | null | undefined,
  input: { kind: NotifyWorkspaceKind; subject: string; nowMs: number },
):
  | { allowed: true; nextStateJson: string }
  | { allowed: false; reason: "duplicate" | "rate_limited"; message: string; nextStateJson: string } {
  const maxCredit = ESCALATION_BURST * ESCALATION_REFILL_MS
  const state = parseEscalationState(rawStateJson, input.nowMs)
  const elapsed = Math.max(0, input.nowMs - state.updatedAtMs)
  const refilledCredit = Math.min(maxCredit, state.creditMs + elapsed)
  const normalizedSubject = clampSingleLine(input.subject, ESCALATION_MAX_SHORT_FIELD_CHARS).toLowerCase()
  const dedupeKey = `${input.kind}\u0000${normalizedSubject}`

  const previousSentAt = state.sentByKey[dedupeKey]
  if (typeof previousSentAt === "number" && input.nowMs - previousSentAt < ESCALATION_DEDUPE_WINDOW_MS) {
    return {
      allowed: false,
      reason: "duplicate",
      message:
        "Already sent: the same kind and subject went to the Workspace orchestrator within the last 30 minutes. Not sent again.",
      nextStateJson: JSON.stringify({
        creditMs: refilledCredit,
        updatedAtMs: input.nowMs,
        sentByKey: state.sentByKey,
      }),
    }
  }

  if (refilledCredit < ESCALATION_REFILL_MS) {
    return {
      allowed: false,
      reason: "rate_limited",
      message:
        "Dropped: rate limit reached for this Squad (1 message per 5 minutes, burst of 3). It was not sent; the heartbeat remains the safety net.",
      nextStateJson: JSON.stringify({
        creditMs: refilledCredit,
        updatedAtMs: input.nowMs,
        sentByKey: state.sentByKey,
      }),
    }
  }

  const nextSentByKey = { ...state.sentByKey, [dedupeKey]: input.nowMs }
  return {
    allowed: true,
    nextStateJson: JSON.stringify({
      creditMs: refilledCredit - ESCALATION_REFILL_MS,
      updatedAtMs: input.nowMs,
      sentByKey: nextSentByKey,
    }),
  }
}

export type ThreadUiStatus = "working" | "awaiting" | "waiting" | "new" | "reviewed" | "failed" | "ready"

export function computeThreadUiStatus(params: {
  isRunning: boolean
  substatus?: string | null
  hasPendingQuestion?: boolean
  hasPendingWakeup?: boolean
  lastRunFailed?: boolean
  messageCount: number
  reviewed: boolean
}): ThreadUiStatus {
  if (params.hasPendingQuestion || (params.isRunning && params.substatus === "AWAITING_QUESTION")) {
    return "awaiting"
  }
  if (params.isRunning) return "working"
  if (params.hasPendingWakeup) return "waiting"
  if (params.lastRunFailed) return "failed"
  if (params.messageCount > 0) return params.reviewed ? "reviewed" : "new"
  return "ready"
}

export interface OrchestratorToolDeps {
  prisma?: AppPrismaClient
  now?: () => Date
  resolveCaller?: (prisma: AppPrismaClient) => Promise<CallingThreadContext>
  startContinuation?: typeof startConversationContinuationRun
  pollIntervalMs?: number
}

function jsonToolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function textToolResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

async function loadThreadSnapshotsForCaller(
  prisma: AppPrismaClient,
  caller: CallingThreadContext,
  options: {
    onlyConversationId?: string
    elevatedSquadId?: string
    includeArchived?: boolean
  } = {},
) {
  const baseWhere = {
    ...accessibleConversationsWhere(caller.workspaceId, caller.userId),
    ...(options.onlyConversationId ? { id: options.onlyConversationId } : {}),
    ...(options.includeArchived || options.onlyConversationId ? {} : { archivedAt: null }),
  }

  const conversations = await prisma.agentConversation.findMany({
    where: baseWhere,
    orderBy: { updatedAt: "desc" },
    take: options.onlyConversationId ? 1 : 200,
    select: {
      id: true,
      title: true,
      squadId: true,
      summary: true,
      prUrl: true,
      archivedAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  })

  if (conversations.length === 0) return { snapshots: [], allAccessible: [] }

  const convIds = conversations.map((c) => c.id)

  const [runs, reviews, supervisions, inboxItems, wakeups, orchestrators] = await Promise.all([
    prisma.agentRun
      .findMany({
        where: { conversationId: { in: convIds } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          conversationId: true,
          status: true,
          substatus: true,
          currentActivity: true,
          error: true,
        },
      })
      .catch(() => []),
    prisma.agentConversationReview
      ? prisma.agentConversationReview
          .findMany({
            where: { conversationId: { in: convIds }, userId: caller.userId },
            select: { conversationId: true, reviewedAt: true },
          })
          .catch(() => [])
      : Promise.resolve([]),
    prisma.agentConversationSupervision
      ? prisma.agentConversationSupervision
          .findMany({
            where: { conversationId: { in: convIds }, supervisorUserId: caller.userId },
            select: {
              conversationId: true,
              managerNotes: true,
              managerNotesUpdatedAt: true,
              managerSourceOrchestratorId: true,
              proposedReplyText: true,
              proposedReplyGeneratedAt: true,
              proposedReplyAuthorOrchestratorId: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
    prisma.agentInboxItem
      ? prisma.agentInboxItem
          .findMany({
            where: { conversationId: { in: convIds }, status: "PENDING" },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              conversationId: true,
              sourceConversationId: true,
              kind: true,
              header: true,
              question: true,
              optionsJson: true,
              multiSelect: true,
              allowOther: true,
              createdAt: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
    prisma.agentScheduledWakeup
      ? prisma.agentScheduledWakeup
          .findMany({
            where: { conversationId: { in: convIds }, status: "PENDING" },
            orderBy: { fireAt: "asc" },
            select: { conversationId: true, fireAt: true, reason: true },
          })
          .catch(() => [])
      : Promise.resolve([]),
    prisma.agentOrchestrator
      ? prisma.agentOrchestrator
          .findMany({
            where: { workspaceId: caller.workspaceId, userId: caller.userId },
            select: {
              id: true,
              scopeType: true,
              scopeKey: true,
              conversationId: true,
              enabled: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
  ])

  const latestRunByConv = new Map<string, (typeof runs)[number]>()
  for (const r of runs) {
    if (!latestRunByConv.has(r.conversationId)) {
      latestRunByConv.set(r.conversationId, r)
    }
  }
  const reviewByConv = new Map(reviews.map((r) => [r.conversationId, r.reviewedAt]))
  const supervisionByConv = new Map(supervisions.map((s) => [s.conversationId, s]))
  const wakeupByConv = new Map<string, (typeof wakeups)[number]>()
  for (const w of wakeups) {
    if (!wakeupByConv.has(w.conversationId)) wakeupByConv.set(w.conversationId, w)
  }
  const orchByConv = new Map(
    orchestrators.filter((o) => o.conversationId).map((o) => [o.conversationId!, o]),
  )

  const pendingDecisionsByConv = new Map<
    string,
    Array<{
      id: string
      header: string | null
      question: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
      allowOther: boolean
      sourceThreadId: string | null
      createdAt: number
    }>
  >()
  const hasPendingQuestionConv = new Set<string>()
  for (const item of inboxItems) {
    if (item.kind === "QUESTION") {
      hasPendingQuestionConv.add(item.conversationId)
      continue
    }
    if (item.kind === "DECISION") {
      let options: Array<{ label: string; description: string }> = []
      if (item.optionsJson) {
        try {
          options = JSON.parse(item.optionsJson)
        } catch {
          options = []
        }
      }
      const list = pendingDecisionsByConv.get(item.conversationId) ?? []
      list.push({
        id: item.id,
        header: item.header,
        question: item.question,
        options,
        multiSelect: item.multiSelect,
        allowOther: item.allowOther,
        sourceThreadId: item.sourceConversationId,
        createdAt: item.createdAt.getTime(),
      })
      pendingDecisionsByConv.set(item.conversationId, list)
    }
  }

  const allAccessible = conversations.map((conv) => {
    const latestRun = latestRunByConv.get(conv.id)
    const isRunning = latestRun?.status === "QUEUED" || latestRun?.status === "RUNNING"
    const lastRunFailed = !isRunning && latestRun?.status === "FAILED"
    const reviewedAt = reviewByConv.get(conv.id)
    const reviewed = Boolean(reviewedAt && reviewedAt >= conv.updatedAt)
    const supervision = supervisionByConv.get(conv.id)
    const pendingDecisions = pendingDecisionsByConv.get(conv.id) ?? []
    const hasPendingQuestion = hasPendingQuestionConv.has(conv.id)
    const hasPendingWakeup = wakeupByConv.has(conv.id)
    const uiStatus = computeThreadUiStatus({
      isRunning,
      substatus: latestRun?.substatus,
      hasPendingQuestion,
      hasPendingWakeup,
      lastRunFailed,
      messageCount: conv._count.messages,
      reviewed,
    })
    const orch = orchByConv.get(conv.id)
    const proposedReply =
      supervision?.proposedReplyText && supervision.proposedReplyText.trim().length > 0
        ? {
            text: supervision.proposedReplyText,
            generatedAt: supervision.proposedReplyGeneratedAt?.getTime() ?? conv.updatedAt.getTime(),
            sourceOrchestratorId: supervision.proposedReplyAuthorOrchestratorId ?? undefined,
          }
        : undefined

    return {
      id: conv.id,
      title: conv.title ?? "Untitled conversation",
      status: conv.archivedAt ? "archived" : isRunning ? "active" : lastRunFailed ? "error" : "waiting",
      uiStatus,
      isRunning,
      currentActivity: isRunning ? (latestRun?.currentActivity ?? undefined) : undefined,
      lastError: lastRunFailed ? (latestRun?.error ?? "Run failed") : undefined,
      reviewed,
      squadId: conv.squadId ?? null,
      summary: conv.summary ?? undefined,
      prUrl: conv.prUrl ?? undefined,
      updatedAt: conv.updatedAt.toISOString(),
      updatedAtMs: conv.updatedAt.getTime(),
      messageCount: conv._count.messages,
      isOrchestrator: Boolean(orch),
      orchestratorScope: orch ? { scopeType: orch.scopeType, scopeKey: orch.scopeKey } : undefined,
      managerNotes: supervision?.managerNotes || undefined,
      managerNotesUpdatedAt: supervision?.managerNotesUpdatedAt?.toISOString() ?? undefined,
      managerNotesSourceOrchestratorId: supervision?.managerSourceOrchestratorId ?? undefined,
      proposedReply,
      pendingDecisions: pendingDecisions.length > 0 ? pendingDecisions : undefined,
      needsYou: Boolean(proposedReply || pendingDecisions.length > 0 || hasPendingQuestion),
    }
  })

  const snapshots = allAccessible.filter((snap) =>
    evaluateThreadCoordinationAccess({
      caller,
      target: { id: snap.id, squadId: snap.squadId },
      elevatedSquadId: options.elevatedSquadId,
      operation: "read",
    }),
  )

  return { snapshots, allAccessible }
}

export async function handleThreadsGetCurrent(deps: OrchestratorToolDeps = {}) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    const { allAccessible } = await loadThreadSnapshotsForCaller(prisma, caller, {
      onlyConversationId: caller.conversationId,
    })
    const current = allAccessible[0]
    if (!current) {
      return jsonToolResult({ error: `Current thread not found: ${caller.conversationId}` }, true)
    }
    return jsonToolResult({
      ...current,
      callerRole: caller.orchestrator
        ? {
            orchestratorId: caller.orchestrator.id,
            scopeType: caller.orchestrator.scopeType,
            scopeKey: caller.orchestrator.scopeKey,
            enabled: caller.orchestrator.enabled,
          }
        : null,
    })
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsList(
  args: { elevatedSquadId?: string; includeArchived?: boolean },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    if (args.elevatedSquadId && caller.orchestrator?.scopeType !== "WORKSPACE") {
      return jsonToolResult({ error: OUTSIDE_COORDINATION_SCOPE_MESSAGE }, true)
    }
    const { snapshots, allAccessible } = await loadThreadSnapshotsForCaller(prisma, caller, {
      elevatedSquadId: args.elevatedSquadId,
      includeArchived: args.includeArchived,
    })

    // Workspace Orchestrator without elevatedSquadId also receives per-Squad rollup summaries.
    if (caller.orchestrator?.scopeType === "WORKSPACE" && !args.elevatedSquadId) {
      const [squads, orchestrators] = await Promise.all([
        prisma.squad.findMany({
          where: { workspaceId: caller.workspaceId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, color: true },
        }),
        prisma.agentOrchestrator
          ? prisma.agentOrchestrator
              .findMany({
                where: {
                  workspaceId: caller.workspaceId,
                  userId: caller.userId,
                  scopeType: "SQUAD",
                },
                select: { scopeKey: true, enabled: true, conversationId: true },
              })
              .catch(() => [])
          : Promise.resolve([]),
      ])
      const orchBySquad = new Map(orchestrators.map((o) => [o.scopeKey, o]))
      const squadSummaries = squads.map((squad) => {
        const inSquad = allAccessible.filter((t) => t.squadId === squad.id)
        const orch = orchBySquad.get(squad.id)
        return {
          squadId: squad.id,
          name: squad.name,
          color: squad.color,
          totalThreads: inSquad.length,
          workingCount: inSquad.filter((t) => t.isRunning).length,
          needsYouCount: inSquad.filter((t) => t.needsYou).length,
          failedCount: inSquad.filter((t) => t.uiStatus === "failed").length,
          orchestratorEnabled: orch ? orch.enabled : false,
          orchestratorThreadId: orch?.conversationId ?? "",
        }
      })
      return jsonToolResult({ threads: snapshots, squadSummaries })
    }

    return jsonToolResult({ threads: snapshots })
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsGetMessages(
  args: { threadId: string; limit?: number; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "read",
    )
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100))
    const rows = await prisma.agentMessage.findMany({
      where: { conversationId: args.threadId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    })
    const messages = rows.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      timestamp: m.createdAt.getTime(),
    }))
    return jsonToolResult(messages)
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsGetLog(
  args: { threadId?: string; limit?: number; type?: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    const targetId = args.threadId?.trim() || caller.conversationId
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      targetId,
      args.elevatedSquadId,
      "read",
    )
    const runs = await prisma.agentRun.findMany({
      where: { conversationId: targetId, workspaceId: caller.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true },
    })
    if (runs.length === 0) {
      return jsonToolResult({
        threadId: targetId,
        total: 0,
        returned: 0,
        entries: [],
      })
    }
    const runIds = runs.map((r) => r.id)
    const rawLimit = args.limit === 0 ? 500 : Math.max(1, Math.min(args.limit ?? 100, 500))
    const events = await prisma.agentRunEvent.findMany({
      where: {
        runId: { in: runIds },
        ...(args.type ? { type: args.type } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
      take: rawLimit,
      select: {
        runId: true,
        seq: true,
        type: true,
        payloadJson: true,
        createdAt: true,
      },
    })
    const entries = events.reverse().map((ev) => {
      let parsedPayload: unknown = ev.payloadJson
      try {
        parsedPayload = JSON.parse(ev.payloadJson)
      } catch {
        parsedPayload = ev.payloadJson
      }
      return {
        ts: ev.createdAt.toISOString(),
        threadId: targetId,
        runId: ev.runId,
        seq: ev.seq,
        type: ev.type,
        event: parsedPayload,
      }
    })
    return jsonToolResult({
      threadId: targetId,
      total: entries.length,
      returned: entries.length,
      entries,
    })
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsListSquads(deps: OrchestratorToolDeps = {}) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    const [squads, orchestrators] = await Promise.all([
      prisma.squad.findMany({
        where: { workspaceId: caller.workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, color: true },
      }),
      prisma.agentOrchestrator
        ? prisma.agentOrchestrator
            .findMany({
              where: {
                workspaceId: caller.workspaceId,
                userId: caller.userId,
                scopeType: "SQUAD",
              },
              select: { scopeKey: true, conversationId: true, enabled: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
    ])
    const orchBySquad = new Map(orchestrators.map((o) => [o.scopeKey, o]))
    const result = squads.map((squad) => {
      const orch = orchBySquad.get(squad.id)
      return {
        id: squad.id,
        name: squad.name,
        color: squad.color,
        orchestratorThreadId: orch?.conversationId ?? undefined,
        orchestratorEnabled: orch ? orch.enabled : false,
      }
    })
    return jsonToolResult(result)
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsSetSquad(
  args: { threadId: string; squadId: string | null; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "write",
    )
    if (
      !evaluateSquadDestinationAccess({
        caller,
        destinationSquadId: args.squadId,
        elevatedSquadId: args.elevatedSquadId,
        targetConversationId: args.threadId,
      })
    ) {
      throw new Error(DESTINATION_OUTSIDE_SCOPE_MESSAGE)
    }
    if (args.squadId !== null) {
      if (!isValidUuid(args.squadId)) {
        throw new Error(`Squad not found: ${args.squadId}`)
      }
      const squad = await prisma.squad.findFirst({
        where: { id: args.squadId, workspaceId: caller.workspaceId },
        select: { id: true },
      })
      if (!squad) {
        throw new Error(`Squad not found: ${args.squadId}`)
      }
    }
    await prisma.agentConversation.update({
      where: { id: args.threadId },
      data: { squadId: args.squadId, updatedAt: new Date() },
      select: { id: true },
    })
    return jsonToolResult({
      success: true,
      threadId: args.threadId,
      squadId: args.squadId,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsCreate(
  args: {
    prompt: string
    title?: string
    squadId?: string | null
    elevatedSquadId?: string
  },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  const startContinuation = deps.startContinuation ?? startConversationContinuationRun
  try {
    const caller = await resolveCaller(prisma)
    const prompt = args.prompt.trim()
    if (!prompt) {
      throw new Error("Prompt must not be empty.")
    }
    const resolvedSquadId =
      args.squadId !== undefined
        ? args.squadId
        : args.elevatedSquadId?.trim()
          ? args.elevatedSquadId.trim()
          : caller.squadId

    if (
      !evaluateSquadDestinationAccess({
        caller,
        destinationSquadId: resolvedSquadId,
        elevatedSquadId: args.elevatedSquadId,
      })
    ) {
      throw new Error(DESTINATION_OUTSIDE_SCOPE_MESSAGE)
    }

    if (resolvedSquadId !== null) {
      if (!isValidUuid(resolvedSquadId)) {
        throw new Error(`Squad not found: ${resolvedSquadId}`)
      }
      const squad = await prisma.squad.findFirst({
        where: { id: resolvedSquadId, workspaceId: caller.workspaceId },
        select: { id: true },
      })
      if (!squad) {
        throw new Error(`Squad not found: ${resolvedSquadId}`)
      }
    }

    const title = (args.title?.trim() || prompt.replace(/\s+/g, " ").slice(0, 80)).slice(0, 255)
    const now = deps.now ? deps.now() : new Date()
    const created = await prisma.agentConversation.create({
      data: {
        workspaceId: caller.workspaceId,
        userId: caller.userId,
        title,
        squadId: resolvedSquadId,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true, title: true },
    })

    const outcome: ContinuationRunOutcome = await startContinuation({
      conversationId: created.id,
      workspaceId: caller.workspaceId,
      userId: caller.userId,
      message: prompt,
      preferredAgentId: caller.agentId,
      deferLaunch: true,
    })

    if (outcome.status === "refused") {
      return jsonToolResult(
        {
          success: false,
          threadId: created.id,
          title: created.title ?? title,
          error: outcome.message,
          code: outcome.code,
        },
        true,
      )
    }

    return jsonToolResult({
      success: true,
      threadId: created.id,
      title: created.title ?? title,
      squadId: resolvedSquadId,
      runId: outcome.runId,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsSendMessage(
  args: { threadId: string; message: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  const startContinuation = deps.startContinuation ?? startConversationContinuationRun
  try {
    const caller = await resolveCaller(prisma)
    const selfCheck = evaluateSendMessageGuard({
      caller,
      targetConversationId: args.threadId,
    })
    if (!selfCheck.allowed) {
      return jsonToolResult({ error: selfCheck.reason }, true)
    }

    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "write",
    )

    if (prisma.agentConversationSupervision) {
      try {
        const supervision = await prisma.agentConversationSupervision.findFirst({
          where: { conversationId: args.threadId, supervisorUserId: caller.userId },
          select: {
            proposedReplyText: true,
            proposedReplyAuthorOrchestratorId: true,
          },
        })
        const guard = evaluateSendMessageGuard({
          caller,
          targetConversationId: args.threadId,
          pendingProposedReply: supervision
            ? {
                text: supervision.proposedReplyText,
                authorOrchestratorId: supervision.proposedReplyAuthorOrchestratorId,
              }
            : null,
        })
        if (!guard.allowed) {
          return jsonToolResult({ error: guard.reason }, true)
        }
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
      }
    }

    const outcome = await startContinuation({
      conversationId: args.threadId,
      workspaceId: caller.workspaceId,
      userId: caller.userId,
      message: args.message,
      deferLaunch: true,
    })

    if (outcome.status === "refused") {
      return jsonToolResult({ success: false, error: outcome.message, code: outcome.code }, true)
    }

    return jsonToolResult({
      success: true,
      threadId: args.threadId,
      runStatus: outcome.status,
      runId: outcome.runId,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsWait(
  args: { threadId: string; timeoutSeconds?: number; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  const pollMs = deps.pollIntervalMs ?? 1_000
  try {
    const caller = await resolveCaller(prisma)
    if (args.threadId === caller.conversationId) {
      return jsonToolResult({ error: "Cannot wait on the current thread." }, true)
    }
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "read",
    )

    const clampedSeconds = Math.max(1, Math.min(args.timeoutSeconds ?? 120, 300))
    const timeoutMs = clampedSeconds * 1_000
    const startMs = Date.now()

    await prisma.agentRun
      .updateMany({
        where: { id: caller.runId, status: "RUNNING" },
        data: { substatus: WAITING_THREADS_SUBSTATUS, updatedAt: new Date() },
      })
      .catch(() => {})

    try {
      while (true) {
        const active = await findActiveAgentRun({ prisma, conversationId: args.threadId })
        if (!active) {
          const elapsedSeconds = Math.round((Date.now() - startMs) / 1_000)
          return jsonToolResult({
            done: true,
            threadId: args.threadId,
            elapsedSeconds,
          })
        }
        const elapsedMs = Date.now() - startMs
        if (elapsedMs >= timeoutMs) {
          return jsonToolResult(
            {
              done: false,
              timedOut: true,
              threadId: args.threadId,
              elapsedSeconds: Math.round(elapsedMs / 1_000),
            },
            true,
          )
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
      }
    } finally {
      await prisma.agentRun
        .updateMany({
          where: { id: caller.runId, status: "RUNNING", substatus: WAITING_THREADS_SUBSTATUS },
          data: { substatus: null, updatedAt: new Date() },
        })
        .catch(() => {})
    }
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsArchive(
  args: { threadId: string; confirm?: boolean; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "write",
    )

    let targetIsOrchestrator = false
    if (prisma.agentOrchestrator) {
      try {
        const orch = await prisma.agentOrchestrator.findFirst({
          where: {
            workspaceId: caller.workspaceId,
            userId: caller.userId,
            conversationId: args.threadId,
          },
          select: { id: true },
        })
        targetIsOrchestrator = Boolean(orch)
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
      }
    }

    if (targetIsOrchestrator && !args.confirm) {
      return jsonToolResult(
        {
          error:
            "This thread is an Orchestrator. Pass confirm: true to archive it anyway — doing so stops automatic thread review until the orchestrator is re-opened.",
        },
        true,
      )
    }

    if (args.threadId === caller.conversationId && !args.confirm) {
      return jsonToolResult({ error: "Cannot archive the current thread." }, true)
    }

    const now = deps.now ? deps.now() : new Date()
    await prisma.agentConversation.update({
      where: { id: args.threadId },
      data: { archivedAt: now, updatedAt: now },
      select: { id: true },
    })

    return jsonToolResult({
      success: true,
      archivedThreadId: args.threadId,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsSetNotes(
  args: { threadId: string; notes: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    // "notes" operation refuses Workspace Orchestrator cross-Squad elevation so Squad manager notes are never overwritten.
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "notes",
    )
    const now = deps.now ? deps.now() : new Date()
    await prisma.agentConversationSupervision.upsert({
      where: {
        conversationId_supervisorUserId: {
          conversationId: args.threadId,
          supervisorUserId: caller.userId,
        },
      },
      create: {
        workspaceId: caller.workspaceId,
        conversationId: args.threadId,
        supervisorUserId: caller.userId,
        managerNotes: args.notes,
        managerNotesUpdatedAt: args.notes.length > 0 ? now : null,
        managerSourceOrchestratorId: caller.orchestrator?.id ?? null,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        managerNotes: args.notes,
        managerNotesUpdatedAt: args.notes.length > 0 ? now : null,
        managerSourceOrchestratorId: caller.orchestrator?.id ?? null,
        updatedAt: now,
      },
      select: { id: true },
    })

    return jsonToolResult({ success: true, threadId: args.threadId })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsSetProposedReply(
  args: { threadId: string; text: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    if (args.threadId === caller.conversationId) {
      return jsonToolResult({ error: "Cannot set a proposed reply on the current thread." }, true)
    }
    const text = args.text.trim()
    if (!text) {
      return jsonToolResult({ error: "Proposed reply text must not be empty." }, true)
    }
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "write",
    )

    if (prisma.agentInboxItem) {
      const openDecisions = await prisma.agentInboxItem.findMany({
        where: {
          conversationId: args.threadId,
          kind: "DECISION",
          status: "PENDING",
        },
        select: { id: true },
      })
      if (openDecisions.length > 0) {
        throw new Error(
          `Thread ${args.threadId} has an open decision awaiting the user (${openDecisions.map((d) => d.id).join(", ")}). Clear it with threads_clear_decision or wait for their answer, then stage a reply built from that answer.`,
        )
      }
    }

    const now = deps.now ? deps.now() : new Date()
    await prisma.agentConversationSupervision.upsert({
      where: {
        conversationId_supervisorUserId: {
          conversationId: args.threadId,
          supervisorUserId: caller.userId,
        },
      },
      create: {
        workspaceId: caller.workspaceId,
        conversationId: args.threadId,
        supervisorUserId: caller.userId,
        proposedReplyText: text,
        proposedReplyGeneratedAt: now,
        proposedReplyAuthorOrchestratorId: caller.orchestrator?.id ?? null,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        proposedReplyText: text,
        proposedReplyGeneratedAt: now,
        proposedReplyAuthorOrchestratorId: caller.orchestrator?.id ?? null,
        updatedAt: now,
      },
      select: { id: true },
    })

    return jsonToolResult({ success: true, threadId: args.threadId })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsClearProposedReply(
  args: { threadId: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    await requireAuthorizedTargetConversation(
      prisma,
      caller,
      args.threadId,
      args.elevatedSquadId,
      "write",
    )
    const now = deps.now ? deps.now() : new Date()
    await prisma.agentConversationSupervision.updateMany({
      where: {
        conversationId: args.threadId,
        supervisorUserId: caller.userId,
      },
      data: {
        proposedReplyText: null,
        proposedReplyGeneratedAt: null,
        proposedReplyAuthorOrchestratorId: null,
        updatedAt: now,
      },
    })
    return jsonToolResult({ success: true, threadId: args.threadId })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsPostDecision(
  args: {
    threadId?: string
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
    allowOther?: boolean
    elevatedSquadId?: string
  },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    const target = args.threadId?.trim() || caller.conversationId
    if (target !== caller.conversationId) {
      await requireAuthorizedTargetConversation(
        prisma,
        caller,
        target,
        args.elevatedSquadId,
        "write",
      )
    }

    const now = deps.now ? deps.now() : new Date()
    const created = await prisma.agentInboxItem.create({
      data: {
        workspaceId: caller.workspaceId,
        conversationId: target,
        recipientUserId: caller.userId,
        sourceConversationId: caller.conversationId,
        runId: caller.runId,
        kind: "DECISION",
        header: args.header ? args.header.trim().slice(0, 120) : null,
        question: args.question.trim(),
        optionsJson: JSON.stringify(
          args.options.map((o) => ({
            label: o.label.trim(),
            description: (o.description ?? "").trim(),
          })),
        ),
        multiSelect: Boolean(args.multiSelect),
        allowOther: args.allowOther ?? true,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })

    return jsonToolResult({
      success: true,
      threadId: target,
      decisionId: created.id,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleThreadsClearDecision(
  args: { threadId?: string; decisionId: string; elevatedSquadId?: string },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    const target = args.threadId?.trim() || caller.conversationId
    if (target !== caller.conversationId) {
      await requireAuthorizedTargetConversation(
        prisma,
        caller,
        target,
        args.elevatedSquadId,
        "write",
      )
    }
    if (!isValidUuid(args.decisionId)) {
      return jsonToolResult({ success: true, threadId: target, cleared: false })
    }
    const now = deps.now ? deps.now() : new Date()
    const updated = await prisma.agentInboxItem.updateMany({
      where: {
        id: args.decisionId,
        conversationId: target,
        workspaceId: caller.workspaceId,
        kind: "DECISION",
        status: "PENDING",
        sourceConversationId: caller.conversationId,
      },
      data: {
        status: "CLEARED",
        resolvedAt: now,
        updatedAt: now,
      },
    })
    return jsonToolResult({
      success: true,
      threadId: target,
      cleared: updated.count > 0,
    })
  } catch (error) {
    return jsonToolResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    )
  }
}

export async function handleNotifyWorkspaceOrchestrator(
  args: {
    kind: NotifyWorkspaceKind
    subject: string
    summary: string
    threadId?: string
    url?: string
  },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  const startContinuation = deps.startContinuation ?? startConversationContinuationRun
  try {
    const caller = await resolveCaller(prisma)
    if (caller.orchestrator?.scopeType !== "SQUAD" || !caller.orchestrator.enabled) {
      return textToolResult(
        "Refused: notify_workspace_orchestrator can only be called by an enabled Squad orchestrator thread.",
        true,
      )
    }

    const subject = clampSingleLine(args.subject, ESCALATION_MAX_SHORT_FIELD_CHARS)
    const summary = clampSingleLine(args.summary, ESCALATION_MAX_SUMMARY_CHARS)
    if (!subject) {
      return textToolResult("Invalid arguments: subject must be a non-empty string.", true)
    }
    if (!summary) {
      return textToolResult("Invalid arguments: summary must be a non-empty string.", true)
    }
    const relatedThread = args.threadId?.trim()
      ? clampSingleLine(args.threadId, ESCALATION_MAX_SHORT_FIELD_CHARS)
      : undefined
    const url = args.url?.trim()
      ? clampSingleLine(args.url, ESCALATION_MAX_SHORT_FIELD_CHARS)
      : undefined

    const [callerOrchRow, workspaceOrch, squad] = await Promise.all([
      prisma.agentOrchestrator.findUnique({
        where: { id: caller.orchestrator.id },
        select: { id: true, lastEscalationStateJson: true },
      }),
      prisma.agentOrchestrator.findFirst({
        where: {
          workspaceId: caller.workspaceId,
          userId: caller.userId,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
        },
        select: {
          id: true,
          conversationId: true,
          agentId: true,
          enabled: true,
          escalationsEnabled: true,
        },
      }),
      prisma.squad
        .findFirst({
          where: { id: caller.orchestrator.scopeKey, workspaceId: caller.workspaceId },
          select: { name: true },
        })
        .catch(() => null),
    ])

    if (
      !workspaceOrch ||
      !workspaceOrch.enabled ||
      !workspaceOrch.escalationsEnabled ||
      !workspaceOrch.conversationId
    ) {
      return textToolResult(
        "No Workspace orchestrator exists (or escalations are disabled), so nothing was sent. Nothing was created.",
      )
    }

    const now = deps.now ? deps.now() : new Date()
    const evaluated = evaluateAndAdvanceEscalationState(
      callerOrchRow?.lastEscalationStateJson,
      {
        kind: args.kind,
        subject,
        nowMs: now.getTime(),
      },
    )

    if (!evaluated.allowed) {
      await prisma.agentOrchestrator
        .update({
          where: { id: caller.orchestrator.id },
          data: { lastEscalationStateJson: evaluated.nextStateJson, updatedAt: now },
          select: { id: true },
        })
        .catch(() => {})
      return textToolResult(evaluated.message)
    }

    const squadLabel = clampSingleLine(
      squad?.name ?? caller.orchestrator.scopeKey,
      ESCALATION_MAX_SHORT_FIELD_CHARS,
    )
    const promptLines = [
      `FYI from the ${squadLabel} Squad orchestrator (${caller.conversationId}), no reply needed.`,
      `Kind: ${args.kind}`,
      `Subject: ${subject}`,
      `Summary: ${summary}`,
      ...(relatedThread ? [`Thread: ${relatedThread}`] : []),
      ...(url ? [`URL: ${url}`] : []),
    ]

    const outcome = await startContinuation({
      conversationId: workspaceOrch.conversationId,
      workspaceId: caller.workspaceId,
      userId: caller.userId,
      message: promptLines.join("\n"),
      preferredAgentId: workspaceOrch.agentId ?? caller.agentId,
      deferLaunch: true,
    })

    if (outcome.status === "already_running") {
      return textToolResult(
        "The Workspace orchestrator is busy and the message was not delivered. Try again later; the heartbeat remains the safety net.",
      )
    }
    if (outcome.status === "refused") {
      return textToolResult(`Could not deliver to the Workspace orchestrator: ${outcome.message}`, true)
    }

    await prisma.agentOrchestrator.update({
      where: { id: caller.orchestrator.id },
      data: { lastEscalationStateJson: evaluated.nextStateJson, updatedAt: now },
      select: { id: true },
    })

    return textToolResult("Sent to the Workspace orchestrator. No reply is expected.")
  } catch (error) {
    return textToolResult(
      `Could not notify the Workspace orchestrator: ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
}

export async function handleThreadsListOrchestrators(deps: OrchestratorToolDeps = {}) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    if (caller.orchestrator?.scopeType !== "WORKSPACE") {
      return jsonToolResult({ error: WORKSPACE_ORCHESTRATOR_ONLY_MESSAGE }, true)
    }

    const [squads, orchestrators] = await Promise.all([
      prisma.squad.findMany({
        where: { workspaceId: caller.workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      prisma.agentOrchestrator.findMany({
        where: { workspaceId: caller.workspaceId, userId: caller.userId },
        select: {
          id: true,
          scopeType: true,
          scopeKey: true,
          conversationId: true,
          enabled: true,
        },
      }),
    ])

    const workspaceOrch = orchestrators.find((o) => o.scopeType === "WORKSPACE")
    const squadOrchByKey = new Map(
      orchestrators.filter((o) => o.scopeType === "SQUAD").map((o) => [o.scopeKey, o]),
    )

    const snapshots = [
      {
        id: workspaceOrch?.id ?? "workspace",
        kind: "workspace" as const,
        title: "Workspace Orchestrator",
        enabled: workspaceOrch?.enabled ?? true,
        threadId: workspaceOrch?.conversationId ?? caller.conversationId,
      },
      ...squads.map((squad) => {
        const orch = squadOrchByKey.get(squad.id)
        return {
          id: orch?.id ?? `squad:${squad.id}`,
          kind: "squad" as const,
          title: `${squad.name} Orchestrator`,
          enabled: orch ? orch.enabled : false,
          threadId: orch?.conversationId ?? "",
          squadId: squad.id,
        }
      }),
    ]

    return jsonToolResult(snapshots)
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export async function handleThreadsSetOrchestratorEnabled(
  args: { squadId: string; enabled?: boolean },
  deps: OrchestratorToolDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma()
  const resolveCaller = deps.resolveCaller ?? resolveCallingThreadContext
  try {
    const caller = await resolveCaller(prisma)
    if (caller.orchestrator?.scopeType !== "WORKSPACE") {
      return jsonToolResult({ error: WORKSPACE_ORCHESTRATOR_ONLY_MESSAGE }, true)
    }
    const squadId = args.squadId.trim()
    if (!isValidUuid(squadId)) {
      return jsonToolResult({ error: `Squad not found: ${squadId}` }, true)
    }
    const squad = await prisma.squad.findFirst({
      where: { id: squadId, workspaceId: caller.workspaceId },
      select: { id: true, name: true },
    })
    if (!squad) {
      return jsonToolResult({ error: `Squad not found: ${squadId}` }, true)
    }

    const enabled = args.enabled ?? true
    const now = deps.now ? deps.now() : new Date()
    const existing = await prisma.agentOrchestrator.findFirst({
      where: {
        userId: caller.userId,
        workspaceId: caller.workspaceId,
        scopeType: "SQUAD",
        scopeKey: squad.id,
      },
      select: {
        id: true,
        conversationId: true,
        enabled: true,
      },
    })

    let conversationId = existing?.conversationId ?? null
    if (enabled && !conversationId) {
      const conv = await prisma.agentConversation.create({
        data: {
          workspaceId: caller.workspaceId,
          userId: caller.userId,
          title: `${squad.name} Orchestrator`,
          squadId: squad.id,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      conversationId = conv.id
    }

    const saved = await prisma.agentOrchestrator.upsert({
      where: {
        userId_workspaceId_scopeType_scopeKey: {
          userId: caller.userId,
          workspaceId: caller.workspaceId,
          scopeType: "SQUAD",
          scopeKey: squad.id,
        },
      },
      create: {
        userId: caller.userId,
        workspaceId: caller.workspaceId,
        scopeType: "SQUAD",
        scopeKey: squad.id,
        conversationId,
        agentId: caller.agentId,
        enabled,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        enabled,
        ...(conversationId ? { conversationId } : {}),
        updatedAt: now,
      },
      select: {
        id: true,
        enabled: true,
        conversationId: true,
      },
    })

    return jsonToolResult({
      id: saved.id,
      kind: "squad",
      title: `${squad.name} Orchestrator`,
      enabled: saved.enabled,
      threadId: saved.conversationId ?? "",
      squadId: squad.id,
    })
  } catch (error) {
    return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export type RegisterMcpToolFn = (
  name: string,
  meta: {
    title: string
    description: string
    inputSchema: Record<string, unknown>
    outputSchema?: unknown
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<any>,
) => void

/**
 * Registers all 17 `threads_*` + `notify_workspace_orchestrator` tools via `app/api/mcp/route.ts`'s
 * `register` wrapper inside the `AGENT_TURN` tool catalog block.
 */
export function registerOrchestratorMcpTools(
  register: RegisterMcpToolFn,
  outputSchema?: unknown,
) {
  register(
    "threads_get_current",
    {
      title: "Get Current Thread",
      description:
        "Returns metadata about the current agent thread: id, title, status, uiStatus, isRunning, squadId, summary, prUrl, updatedAt, messageCount, callerRole, managerNotes, proposedReply, and pendingDecisions. Only callable during an active in-app agent turn.",
      inputSchema: {},
      outputSchema,
    },
    async () => handleThreadsGetCurrent(),
  )

  register(
    "threads_list",
    {
      title: "List Threads",
      description:
        "Returns all agent threads accessible to the user in your coordination scope with their id, title, status, uiStatus, isRunning, squadId, summary, prUrl, updatedAt, messageCount, managerNotes, proposedReply, and pendingDecisions. Workspace Orchestrators also receive squadSummaries and may pass elevatedSquadId to inspect a specific Squad.",
      inputSchema: {
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicitly elevate this call into one Squad."),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived conversations (default false)."),
      },
      outputSchema,
    },
    async (args) => handleThreadsList(args),
  )

  register(
    "threads_get_messages",
    {
      title: "Get Thread Messages",
      description:
        "Returns the live message history of an agent thread in your coordination scope. Use limit to get the most recent N messages (default 20, max 100).",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to read"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only the last N messages (default 20, max 100)"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsGetMessages(args),
  )

  register(
    "threads_get_log",
    {
      title: "Get Thread Log",
      description:
        "Returns parsed event entries from a thread's run event log (tool calls, assistant messages, status updates, and terminal results), filtered by type and tailed to the most recent N entries (default 100).",
      inputSchema: {
        threadId: z
          .string()
          .optional()
          .describe("ID of the thread whose log to read. Defaults to the current thread."),
        limit: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Return only the most recent N entries (default 100, max 500)."),
        type: z
          .string()
          .optional()
          .describe("Optional event type filter (e.g. 'assistant', 'status', 'result')."),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsGetLog(args),
  )

  register(
    "threads_list_squads",
    {
      title: "List Squads for Threads",
      description:
        "Returns all Squads in the current workspace with their id, name, color, and Squad orchestrator status.",
      inputSchema: {},
      outputSchema,
    },
    async () => handleThreadsListSquads(),
  )

  register(
    "threads_set_squad",
    {
      title: "Set Thread Squad",
      description:
        "Assigns a thread to a Squad or clears its Squad assignment (pass squadId: null). Unassigned threads may self-assign to a Squad.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to update"),
        squadId: z
          .string()
          .nullable()
          .describe("Squad ID to assign to the thread, or null to clear the Squad assignment"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsSetSquad(args),
  )

  register(
    "threads_create",
    {
      title: "Create Thread",
      description:
        "Creates a new persistent agent thread in the workspace and immediately queues its initial prompt. Inherits the current thread's Squad unless squadId is specified.",
      inputSchema: {
        prompt: z.string().trim().min(1).describe("The initial prompt to queue in the new thread"),
        title: z.string().min(1).optional().describe("Optional title for the new thread"),
        squadId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Optional Squad ID override. Omit to inherit the current Squad; pass null to create without a Squad.",
          ),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this creation."),
      },
      outputSchema,
    },
    async (args) => handleThreadsCreate(args),
  )

  register(
    "threads_send_message",
    {
      title: "Send Message to Thread",
      description:
        "Sends a user message to another thread in your coordination scope, launching a continuation turn. Cannot target the current thread or a thread with an unapproved proposed reply.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to send the message to"),
        message: z.string().min(1).describe("The message text to send"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsSendMessage(args),
  )

  register(
    "threads_wait",
    {
      title: "Wait for Thread",
      description:
        "Blocks inside the held-open sandbox until the specified thread finishes its active run (up to 300s, default 120s). Returns immediately if the thread is already idle.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to wait for"),
        timeoutSeconds: z
          .number()
          .optional()
          .describe("Maximum seconds to wait before giving up (default 120, max 300)"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsWait(args),
  )

  register(
    "threads_archive",
    {
      title: "Archive Thread",
      description:
        "Archives a thread in your coordination scope. Cannot archive the current thread; archiving an Orchestrator thread requires confirm: true.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to archive"),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true to archive an Orchestrator thread."),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsArchive(args),
  )

  register(
    "threads_set_notes",
    {
      title: "Set Thread Manager Notes",
      description:
        "Sets (overwrites) a thread's orchestrator tracking notes (inferred goal, state, and last-reviewed cursor). Visible on the Agent Board and in Chat but never injected into any session's context. Pass an empty string to clear.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to annotate"),
        notes: z
          .string()
          .describe("Tracking notes text. Pass an empty string to clear existing notes."),
        elevatedSquadId: z
          .string()
          .optional()
          .describe(
            "Reserved for explicit Workspace orchestrator reads; elevation cannot overwrite Squad manager notes.",
          ),
      },
      outputSchema,
    },
    async (args) => handleThreadsSetNotes(args),
  )

  register(
    "threads_set_proposed_reply",
    {
      title: "Set Thread Proposed Reply",
      description:
        "Stages an AI-proposed next message on a thread, awaiting human approval (rendered with Approve & Send / Edit / Discard actions). Nothing is sent automatically. Cannot target the current thread or a thread with an open decision.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to propose a reply for"),
        text: z.string().describe("The proposed reply text"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsSetProposedReply(args),
  )

  register(
    "threads_clear_proposed_reply",
    {
      title: "Clear Thread Proposed Reply",
      description: "Clears a thread's pending proposed reply without sending it.",
      inputSchema: {
        threadId: z.string().describe("ID of the thread to clear the proposed reply on"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsClearProposedReply(args),
  )

  register(
    "threads_post_decision",
    {
      title: "Post Thread Decision",
      description:
        "Posts a structured 2-4 option decision for the user on the target thread's Agent Board card (defaults to the current thread). When answered, the user's choice is delivered back to THIS orchestrator thread.",
      inputSchema: {
        threadId: z
          .string()
          .optional()
          .describe("Thread the decision concerns. Defaults to the current thread."),
        question: z.string().describe("The full question for the user"),
        header: z
          .string()
          .optional()
          .describe("Short label (max 60 chars) shown above the question"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Short option label"),
              description: z.string().optional().describe("One line explaining the option"),
            }),
          )
          .min(2)
          .max(4)
          .describe("2-4 mutually exclusive (or multi-select) options"),
        multiSelect: z
          .boolean()
          .optional()
          .describe("Allow choosing more than one option (default false)"),
        allowOther: z
          .boolean()
          .optional()
          .describe("Offer a free-text Other answer (default true)"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsPostDecision(args),
  )

  register(
    "threads_clear_decision",
    {
      title: "Clear Thread Decision",
      description:
        "Withdraws a pending decision you previously posted with threads_post_decision.",
      inputSchema: {
        threadId: z
          .string()
          .optional()
          .describe("Thread the decision was posted on. Defaults to the current thread."),
        decisionId: z.string().describe("The decisionId returned by threads_post_decision"),
        elevatedSquadId: z
          .string()
          .optional()
          .describe("Workspace orchestrator only: explicit Squad elevation for this call."),
      },
      outputSchema,
    },
    async (args) => handleThreadsClearDecision(args),
  )

  register(
    "notify_workspace_orchestrator",
    {
      title: "Notify Workspace Orchestrator",
      description:
        "Squad orchestrator only. Sends the Workspace orchestrator a rate-limited (1 msg / 5m, burst 3; 30m kind+subject dedup; 400-char cap) one-way FYI about an error you cannot fix, a needs-you item older than 15 minutes, a PR ready for review, a release shipped, cross-Squad blocker, or lost thread.",
      inputSchema: {
        kind: z
          .enum(NOTIFY_WORKSPACE_KINDS)
          .describe("What happened: error, needs_you, pr_ready, release, blocked, or lost_thread."),
        subject: z
          .string()
          .describe("Thread id, PR url, or short key naming what this is about. Used to de-duplicate."),
        summary: z
          .string()
          .describe("One or two sentences, at most 400 characters (longer is truncated)."),
        threadId: z.string().optional().describe("Optional: the related thread id."),
        url: z.string().optional().describe("Optional: a PR or release url."),
      },
      outputSchema,
    },
    async (args) => handleNotifyWorkspaceOrchestrator(args),
  )

  register(
    "threads_list_orchestrators",
    {
      title: "List Orchestrators",
      description:
        "Workspace orchestrator only. Lists the Workspace orchestrator and every Squad orchestrator as { id, kind, title, enabled, threadId, squadId }.",
      inputSchema: {},
      outputSchema,
    },
    async () => handleThreadsListOrchestrators(),
  )

  register(
    "threads_set_orchestrator_enabled",
    {
      title: "Set Squad Orchestrator Enabled",
      description:
        "Workspace orchestrator only. Enables (creating its thread if needed) or disables a Squad orchestrator. Returns the updated orchestrator snapshot.",
      inputSchema: {
        squadId: z
          .string()
          .trim()
          .min(1)
          .describe("ID of the Squad whose orchestrator to enable or disable"),
        enabled: z.boolean().default(true).describe("true (default) enables, false disables"),
      },
      outputSchema,
    },
    async (args) => handleThreadsSetOrchestratorEnabled(args),
  )
}
