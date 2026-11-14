/**
 * Interactive `AskUserQuestion` lifecycle (migration 121):
 *   1. Hold-open sandbox path: the sandbox worker posts structured questions to
 *      `/api/internal/agent/runs/[runId]/questions`, sets `AgentRun.substatus = "AWAITING_QUESTION"`,
 *      and polls `/heartbeat` every 2s. Answering in Compass writes `answerText` onto `AgentInboxItem`,
 *      clears `substatus`, and delivers the answer on the next heartbeat with zero cold boot.
 *   2. Deadline-park fallback: if the run hits `deadlineAt - 30s` before the human responds, the worker
 *      saves docs + its SDK session transcript and exits with `errorCode = "AWAITING_USER"`. The
 *      `AgentInboxItem` stays `PENDING`, keeping the thread in the `Awaiting` column; answering later
 *      resumes via `startConversationContinuationRun` (`AgentSession` + persistent sandbox disk).
 *
 * Every read and write tolerates `121_agent_interactive_controls` being unapplied (`P2021` / `P2022`).
 */

import { z } from "zod"
import type { AppPrismaClient } from "@/lib/db"
import { DELETE_BATCH_SIZE, deleteInBatches, isMissingTable } from "@/lib/batched-delete"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import {
  AgentRunError,
  authorizeAgentRunWorker,
  type AgentRunStatus,
} from "@/lib/agent-runs"
import {
  startConversationContinuationRun,
  type ContinuationDeps,
  type ContinuationRunOutcome,
} from "@/lib/agent-continuation-run"

export const AWAITING_QUESTION_SUBSTATUS = "AWAITING_QUESTION"
export const MAX_QUESTIONS_PER_CALL = 4
export const MAX_QUESTION_OPTIONS = 6

export const questionOptionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
})

export const incomingQuestionSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  header: z.string().trim().min(1).max(80).optional(),
  options: z.array(questionOptionSchema).max(MAX_QUESTION_OPTIONS).optional(),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
})

export const postRunQuestionsBodySchema = z.object({
  nativeToolUseId: z.string().trim().min(1).max(191).optional(),
  questions: z.array(incomingQuestionSchema).min(1).max(MAX_QUESTIONS_PER_CALL),
})

export type QuestionOption = z.infer<typeof questionOptionSchema>

export type SerializedPendingQuestion = {
  id: string
  conversationId: string
  runId: string | null
  header: string | null
  question: string
  options: QuestionOption[]
  multiSelect: boolean
  allowOther: boolean
  status: "PENDING" | "ANSWERED" | "CLEARED" | "EXPIRED"
  answerText: string | null
  createdAt: string
}

export type HeartbeatQuestionState = {
  id: string
  header: string | null
  question: string
  status: string
  answerText: string | null
}

export class AgentQuestionError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "AgentQuestionError"
    this.status = status
    this.code = code
  }
}

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2022"
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function parseQuestionOptions(optionsJson: string | null | undefined): QuestionOption[] {
  if (!optionsJson) return []
  try {
    const parsed = JSON.parse(optionsJson) as unknown
    if (!Array.isArray(parsed)) return []
    const options: QuestionOption[] = []
    for (const raw of parsed) {
      const checked = questionOptionSchema.safeParse(raw)
      if (checked.success) options.push(checked.data)
    }
    return options
  } catch {
    return []
  }
}

function serializeQuestionRow(row: {
  id: string
  conversationId: string
  runId: string | null
  header: string | null
  question: string
  optionsJson: string | null
  multiSelect: boolean
  allowOther: boolean
  status: string
  answerText: string | null
  createdAt: Date
}): SerializedPendingQuestion {
  const status =
    row.status === "ANSWERED" || row.status === "CLEARED" || row.status === "EXPIRED"
      ? row.status
      : "PENDING"
  return {
    id: row.id,
    conversationId: row.conversationId,
    runId: row.runId,
    header: row.header,
    question: row.question,
    options: parseQuestionOptions(row.optionsJson),
    multiSelect: row.multiSelect,
    allowOther: row.allowOther,
    status,
    answerText: row.answerText,
    createdAt: row.createdAt.toISOString(),
  }
}

const QUESTION_ROW_SELECT = {
  id: true,
  workspaceId: true,
  conversationId: true,
  runId: true,
  nativeToolUseId: true,
  header: true,
  question: true,
  optionsJson: true,
  multiSelect: true,
  allowOther: true,
  status: true,
  answerText: true,
  createdAt: true,
} as const

/**
 * Worker-authenticated creation of `AskUserQuestion` items for an active `AgentRun`.
 * Idempotent per `(runId, nativeToolUseId)` so transient network retries never duplicate prompts.
 */
export async function postAgentRunQuestions({
  prisma,
  runId,
  rawToken,
  nativeToolUseId,
  questions,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  runId: string
  rawToken: string
  nativeToolUseId?: string
  questions: z.infer<typeof incomingQuestionSchema>[]
  now?: Date
}): Promise<{ questions: SerializedPendingQuestion[]; deadlineAt: string }> {
  const run = await authorizeAgentRunWorker({ prisma, runId, rawToken, now })
  const toolKey = nativeToolUseId?.trim() || "default"

  try {
    const existing = await prisma.agentInboxItem.findMany({
      where: { runId, nativeToolUseId: toolKey, kind: "QUESTION" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: QUESTION_ROW_SELECT,
    })
    if (existing.length > 0) {
      return {
        questions: existing.map(serializeQuestionRow),
        deadlineAt: run.deadlineAt.toISOString(),
      }
    }

    const created: SerializedPendingQuestion[] = []
    for (let index = 0; index < questions.length; index += 1) {
      const q = questions[index]!
      const createdAt = new Date(now.getTime() + index)
      const inserted = await prisma.agentInboxItem.create({
        data: {
          workspaceId: run.workspaceId,
          conversationId: run.conversationId,
          recipientUserId: run.userId,
          sourceConversationId: run.conversationId,
          runId,
          nativeToolUseId: toolKey,
          kind: "QUESTION",
          header: q.header ? clip(q.header, 80) : null,
          question: clip(q.question, 1_000),
          optionsJson: q.options && q.options.length > 0 ? JSON.stringify(q.options) : null,
          multiSelect: Boolean(q.multiSelect),
          allowOther: q.allowOther ?? true,
          status: "PENDING",
          createdAt,
          updatedAt: now,
        },
        select: QUESTION_ROW_SELECT,
      })
      created.push(serializeQuestionRow(inserted))
    }

    const leadLabel = questions[0]?.header || questions[0]?.question || "question"
    const activity = clip(`Waiting for your answer: ${leadLabel}`, 240)
    try {
      await prisma.agentRun.updateMany({
        where: { id: runId, status: "RUNNING" },
        data: {
          substatus: AWAITING_QUESTION_SUBSTATUS,
          currentActivity: activity,
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      })
    } catch (error) {
      if (!isMissingSchemaObject(error)) throw error
      await prisma.agentRun.updateMany({
        where: { id: runId, status: "RUNNING" },
        data: { lastHeartbeatAt: now, updatedAt: now },
      })
    }

    await prisma.agentConversation
      .update({ where: { id: run.conversationId }, data: { updatedAt: now }, select: { id: true } })
      .catch(() => {})

    return {
      questions: created,
      deadlineAt: run.deadlineAt.toISOString(),
    }
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      throw new AgentRunError(
        "Interactive questions require migration 121_agent_interactive_controls.",
        503,
        "INTERACTIVE_CONTROLS_UNAVAILABLE",
      )
    }
    throw error
  }
}

/** Embedded into `recordAgentRunHeartbeat` so a paused sandbox receives answers over its heartbeat loop. */
export async function listRunQuestionsForHeartbeat(
  prisma: Pick<AppPrismaClient, "agentInboxItem">,
  runId: string,
): Promise<HeartbeatQuestionState[]> {
  if (!prisma.agentInboxItem) return []
  try {
    const rows = await prisma.agentInboxItem.findMany({
      where: { runId, kind: "QUESTION" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        header: true,
        question: true,
        status: true,
        answerText: true,
      },
    })
    return rows
  } catch (error) {
    if (isMissingSchemaObject(error)) return []
    throw error
  }
}

/** Session-authorized read of pending `AskUserQuestion` prompts for a single conversation. */
export async function listConversationPendingQuestions(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string },
): Promise<SerializedPendingQuestion[]> {
  const access = await resolveConversationAccess(prisma, input)
  if (!access) throw new AgentQuestionError("Conversation not found", 404, "CONVERSATION_NOT_FOUND")
  if (!prisma.agentInboxItem) return []
  try {
    const rows = await prisma.agentInboxItem.findMany({
      where: {
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        kind: "QUESTION",
        status: "PENDING",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: QUESTION_ROW_SELECT,
    })
    return rows.map(serializeQuestionRow)
  } catch (error) {
    if (isMissingSchemaObject(error)) return []
    throw error
  }
}

/** Batch board loader (`P2021`-tolerant) returning pending questions keyed by `conversationId`. */
export async function loadPendingQuestionsByConversation(
  prisma: Partial<Pick<AppPrismaClient, "agentInboxItem">>,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<Map<string, SerializedPendingQuestion[]>> {
  const grouped = new Map<string, SerializedPendingQuestion[]>()
  if (!prisma.agentInboxItem || conversationIds.length === 0) return grouped
  try {
    const rows = await prisma.agentInboxItem.findMany({
      where: {
        workspaceId,
        conversationId: { in: [...conversationIds] },
        kind: "QUESTION",
        status: "PENDING",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: QUESTION_ROW_SELECT,
    })
    for (const row of rows) {
      const list = grouped.get(row.conversationId) ?? []
      list.push(serializeQuestionRow(row))
      grouped.set(row.conversationId, list)
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
  return grouped
}

function formatQuestionAnswerMessage(
  items: readonly { header: string | null; question: string; answerText: string | null }[],
): string {
  if (items.length === 1) {
    const item = items[0]!
    const prefix = item.header ? `[${item.header}] ` : ""
    return `${prefix}${item.question}\nAnswer: ${item.answerText ?? ""}`
  }
  return items
    .map((item, idx) => {
      const title = item.header ? `${item.header}: ${item.question}` : item.question
      return `${idx + 1}. ${title}\nAnswer: ${item.answerText ?? ""}`
    })
    .join("\n\n")
}

export type AnswerQuestionResult = {
  itemId: string
  conversationId: string
  delivery: "live_run" | "continuation_queued_on_remaining" | "continuation_run"
  remainingPendingCount: number
  runId: string | null
  continuation?: ContinuationRunOutcome
}

/**
 * Records a user's answer to a `PENDING` `AskUserQuestion` item.
 *   - If the originating `AgentRun` is still `RUNNING` inside its deadline, updates the item in-place
 *     and clears `substatus` once all batch questions are answered so the live worker resumes on its
 *     next 2s heartbeat.
 *   - Otherwise (deadline-parked / interrupted run), waits until any sibling questions from the same
 *     batch are answered and starts a continuation run (`AgentSession` + persistent disk).
 */
export async function answerAgentQuestion({
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
}): Promise<AnswerQuestionResult> {
  const cleanAnswer = answerText.trim()
  if (!cleanAnswer) {
    throw new AgentQuestionError("Answer text is required.", 400, "EMPTY_ANSWER")
  }
  if (cleanAnswer.length > 4_000) {
    throw new AgentQuestionError("Answer text must be 4,000 characters or fewer.", 400, "ANSWER_TOO_LONG")
  }

  let item: {
    id: string
    workspaceId: string
    conversationId: string
    runId: string | null
    nativeToolUseId: string | null
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
        runId: true,
        nativeToolUseId: true,
        kind: true,
        header: true,
        question: true,
        status: true,
      },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      throw new AgentQuestionError("Question not found.", 404, "QUESTION_NOT_FOUND")
    }
    throw error
  }

  if (!item || item.kind !== "QUESTION") {
    throw new AgentQuestionError("Question not found.", 404, "QUESTION_NOT_FOUND")
  }

  const access = await resolveConversationAccess(prisma, {
    conversationId: item.conversationId,
    workspaceId: item.workspaceId,
    userId,
  })
  if (!access) {
    throw new AgentQuestionError("Question not found.", 404, "QUESTION_NOT_FOUND")
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
    throw new AgentQuestionError("This question has already been answered or closed.", 409, "QUESTION_ALREADY_RESOLVED")
  }

  await prisma.agentConversation
    .update({ where: { id: item.conversationId }, data: { updatedAt: now }, select: { id: true } })
    .catch(() => {})

  // Check whether the originating run is still live and inside its deadline.
  let liveRun: { id: string; status: string; deadlineAt: Date; agentId?: string | null } | null = null
  if (item.runId) {
    try {
      liveRun = await prisma.agentRun.findUnique({
        where: { id: item.runId },
        select: { id: true, status: true, deadlineAt: true, agentId: true },
      })
    } catch (error) {
      if (!isMissingSchemaObject(error)) throw error
      liveRun = await prisma.agentRun.findUnique({
        where: { id: item.runId },
        select: { id: true, status: true, deadlineAt: true },
      })
    }
  }

  const isLive = Boolean(liveRun && liveRun.status === "RUNNING" && liveRun.deadlineAt.getTime() > now.getTime())

  if (isLive && liveRun) {
    const remainingPendingCount = await prisma.agentInboxItem.count({
      where: { runId: liveRun.id, kind: "QUESTION", status: "PENDING" },
    })
    if (remainingPendingCount === 0) {
      try {
        await prisma.agentRun.updateMany({
          where: { id: liveRun.id, status: "RUNNING" },
          data: {
            substatus: null,
            currentActivity: "Received your answer — continuing…",
            updatedAt: now,
          },
        })
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
      }
    }
    return {
      itemId: item.id,
      conversationId: item.conversationId,
      delivery: "live_run",
      remainingPendingCount,
      runId: liveRun.id,
    }
  }

  // Deadline-parked / terminal run fallback: wait until all questions in the conversation are answered,
  // then resume via `startConversationContinuationRun`.
  const remainingPendingCount = await prisma.agentInboxItem.count({
    where: { conversationId: item.conversationId, kind: "QUESTION", status: "PENDING" },
  })
  if (remainingPendingCount > 0) {
    return {
      itemId: item.id,
      conversationId: item.conversationId,
      delivery: "continuation_queued_on_remaining",
      remainingPendingCount,
      runId: null,
    }
  }

  const batchItems = item.runId
    ? await prisma.agentInboxItem.findMany({
        where: {
          runId: item.runId,
          kind: "QUESTION",
          status: "ANSWERED",
          ...(item.nativeToolUseId ? { nativeToolUseId: item.nativeToolUseId } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { header: true, question: true, answerText: true },
      })
    : [{ header: item.header, question: item.question, answerText: cleanAnswer }]

  const formattedMessage = formatQuestionAnswerMessage(
    batchItems.length > 0 ? batchItems : [{ header: item.header, question: item.question, answerText: cleanAnswer }],
  )
  const continuation = await startConversationContinuationRun(
    {
      conversationId: item.conversationId,
      workspaceId: item.workspaceId,
      userId,
      message: formattedMessage,
      preferredAgentId: liveRun?.agentId,
      deferLaunch: true,
    },
    continuationDeps,
  )

  return {
    itemId: item.id,
    conversationId: item.conversationId,
    delivery: "continuation_run",
    remainingPendingCount: 0,
    runId: continuation.status === "started" ? continuation.runId : continuation.status === "already_running" ? continuation.runId ?? null : null,
    continuation,
  }
}

/**
 * Called by `finalizeAgentRun`:
 *   - `SUCCEEDED` or `CANCELED`: clears any `PENDING` questions for that run so stale prompts don't linger.
 *   - `INTERRUPTED` or `FAILED`: preserves `PENDING` questions so late human answers can still resume the thread.
 */
export async function settleRunQuestionsOnFinalize(
  prisma: Partial<Pick<AppPrismaClient, "agentInboxItem">>,
  input: {
    runId: string
    terminalRunStatus: Extract<AgentRunStatus, "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED">
    now?: Date
  },
): Promise<void> {
  if (!prisma.agentInboxItem) return
  if (input.terminalRunStatus !== "SUCCEEDED" && input.terminalRunStatus !== "CANCELED") return
  const now = input.now ?? new Date()
  try {
    await prisma.agentInboxItem.updateMany({
      where: { runId: input.runId, kind: "QUESTION", status: "PENDING" },
      data: { status: "CLEARED", resolvedAt: now, updatedAt: now },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}

/** Clears any `PENDING` questions on a conversation when a human manually sends a new chat turn. */
export async function clearConversationPendingQuestions(
  prisma: Partial<Pick<AppPrismaClient, "agentInboxItem">>,
  input: { conversationId: string; now?: Date },
): Promise<void> {
  if (!prisma.agentInboxItem) return
  const now = input.now ?? new Date()
  try {
    await prisma.agentInboxItem.updateMany({
      where: { conversationId: input.conversationId, kind: "QUESTION", status: "PENDING" },
      data: { status: "CLEARED", resolvedAt: now, updatedAt: now },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}

/** Batched workspace teardown helper (`P2021`-tolerant). */
export async function deleteWorkspaceAgentInboxItems(
  prisma: Partial<Pick<AppPrismaClient, "agentInboxItem">>,
  workspaceId: string,
): Promise<number> {
  if (!prisma.agentInboxItem) return 0
  try {
    return await deleteInBatches(prisma.agentInboxItem, { workspaceId }, { batchSize: DELETE_BATCH_SIZE })
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}
