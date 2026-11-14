import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

const mocks = vi.hoisted(() => ({
  authorizeWorker: vi.fn(),
  resolveAccess: vi.fn(),
  startContinuation: vi.fn(),
}))

vi.mock("@/lib/agent-runs", async (original) => ({
  ...(await original<object>()),
  authorizeAgentRunWorker: (...args: unknown[]) => mocks.authorizeWorker(...args),
}))

vi.mock("@/lib/agent-conversation-access", () => ({
  resolveConversationAccess: (...args: unknown[]) => mocks.resolveAccess(...args),
}))

vi.mock("@/lib/agent-continuation-run", () => ({
  startConversationContinuationRun: (...args: unknown[]) => mocks.startContinuation(...args),
}))

import {
  answerAgentQuestion,
  listRunQuestionsForHeartbeat,
  postAgentRunQuestions,
  settleRunQuestionsOnFinalize,
} from "@/lib/agent-inbox-questions"

type StoredItem = {
  id: string
  workspaceId: string
  conversationId: string
  recipientUserId: string | null
  sourceConversationId: string | null
  runId: string | null
  nativeToolUseId: string | null
  kind: string
  header: string | null
  question: string
  optionsJson: string | null
  multiSelect: boolean
  allowOther: boolean
  status: string
  answerText: string | null
  resolvedByUserId: string | null
  createdAt: Date
  resolvedAt: Date | null
  updatedAt: Date
}

describe("lib/agent-inbox-questions", () => {
  const now = new Date("2026-11-14T12:00:00.000Z")
  const deadline = new Date("2026-11-14T12:10:00.000Z")
  let items: StoredItem[]
  let runRow: { id: string; status: string; deadlineAt: Date; substatus: string | null; currentActivity: string | null }
  let prisma: AppPrismaClient

  beforeEach(() => {
    vi.clearAllMocks()
    items = []
    runRow = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "RUNNING",
      deadlineAt: deadline,
      substatus: null,
      currentActivity: "Thinking…",
    }

    mocks.authorizeWorker.mockResolvedValue({
      id: runRow.id,
      workspaceId: "ws-1",
      conversationId: "conv-1",
      userId: "user-1",
      deadlineAt: deadline,
    })
    mocks.resolveAccess.mockResolvedValue({ role: "OWNER" })
    mocks.startContinuation.mockResolvedValue({
      status: "started",
      runId: "22222222-2222-4222-8222-222222222222",
      conversationId: "conv-1",
      launched: true,
    })

    let seq = 0
    prisma = {
      agentInboxItem: {
        findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
          return items.filter((item) => {
            if (where?.runId && item.runId !== where.runId) return false
            if (where?.conversationId && item.conversationId !== where.conversationId) return false
            if (where?.nativeToolUseId && item.nativeToolUseId !== where.nativeToolUseId) return false
            if (where?.kind && item.kind !== where.kind) return false
            if (where?.status && item.status !== where.status) return false
            return true
          })
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return items.find((item) => item.id === where.id) ?? null
        }),
        create: vi.fn(async ({ data }: { data: Omit<StoredItem, "id" | "answerText" | "resolvedByUserId" | "resolvedAt"> }) => {
          seq += 1
          const row: StoredItem = {
            id: `00000000-0000-4000-8000-00000000000${seq}`,
            answerText: null,
            resolvedByUserId: null,
            resolvedAt: null,
            ...data,
          }
          items.push(row)
          return row
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<StoredItem> }) => {
          let count = 0
          for (const item of items) {
            if (where.id && item.id !== where.id) continue
            if (where.runId && item.runId !== where.runId) continue
            if (where.conversationId && item.conversationId !== where.conversationId) continue
            if (where.kind && item.kind !== where.kind) continue
            if (where.status && item.status !== where.status) continue
            Object.assign(item, data)
            count += 1
          }
          return { count }
        }),
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return items.filter((item) => {
            if (where.runId && item.runId !== where.runId) return false
            if (where.conversationId && item.conversationId !== where.conversationId) return false
            if (where.kind && item.kind !== where.kind) return false
            if (where.status && item.status !== where.status) return false
            return true
          }).length
        }),
      },
      agentRun: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === runRow.id ? runRow : null)),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Partial<typeof runRow> }) => {
          if (where.id === runRow.id && where.status === runRow.status) {
            Object.assign(runRow, data)
            return { count: 1 }
          }
          return { count: 0 }
        }),
      },
      agentConversation: {
        update: vi.fn(async () => ({ id: "conv-1" })),
      },
    } as unknown as AppPrismaClient
  })

  it("creates structured questions idempotently per (runId, nativeToolUseId) and marks run AWAITING_QUESTION", async () => {
    const first = await postAgentRunQuestions({
      prisma,
      runId: runRow.id,
      rawToken: "worker-tok",
      nativeToolUseId: "chat-ask-1",
      questions: [
        {
          header: "Launch Tier",
          question: "Which tier should this launch target?",
          options: [{ label: "Tier 1", description: "Full GTM" }, { label: "Tier 2" }],
        },
      ],
      now,
    })

    expect(first.questions).toHaveLength(1)
    expect(first.questions[0]?.options).toEqual([{ label: "Tier 1", description: "Full GTM" }, { label: "Tier 2" }])
    expect(runRow.substatus).toBe("AWAITING_QUESTION")

    // Retry with same nativeToolUseId returns existing row without duplicating
    const retry = await postAgentRunQuestions({
      prisma,
      runId: runRow.id,
      rawToken: "worker-tok",
      nativeToolUseId: "chat-ask-1",
      questions: [{ question: "Duplicate?" }],
      now,
    })
    expect(retry.questions).toHaveLength(1)
    expect(retry.questions[0]?.id).toBe(first.questions[0]?.id)
  })

  it("delivers answers to a live RUNNING run via heartbeat snapshot and clears AWAITING_QUESTION", async () => {
    const created = await postAgentRunQuestions({
      prisma,
      runId: runRow.id,
      rawToken: "worker-tok",
      nativeToolUseId: "chat-ask-2",
      questions: [{ header: "Scope", question: "Include mobile?" }],
      now,
    })
    const qId = created.questions[0]!.id

    const result = await answerAgentQuestion({
      prisma,
      itemId: qId,
      userId: "user-1",
      answerText: "Web first, mobile in Phase 2",
      now,
    })

    expect(result).toEqual({
      itemId: qId,
      conversationId: "conv-1",
      delivery: "live_run",
      remainingPendingCount: 0,
      runId: runRow.id,
    })
    expect(runRow.substatus).toBeNull()
    expect(mocks.startContinuation).not.toHaveBeenCalled()

    const hb = await listRunQuestionsForHeartbeat(prisma, runRow.id)
    expect(hb).toEqual([
      expect.objectContaining({
        id: qId,
        nativeToolUseId: "chat-ask-2",
        status: "ANSWERED",
        answerText: "Web first, mobile in Phase 2",
      }),
    ])
  })

  it("starts a continuation run when answering a deadline-parked INTERRUPTED run", async () => {
    const created = await postAgentRunQuestions({
      prisma,
      runId: runRow.id,
      rawToken: "worker-tok",
      nativeToolUseId: "chat-ask-3",
      questions: [{ header: "Target", question: "Which region?" }],
      now,
    })
    const qId = created.questions[0]!.id

    // Simulate deadline park (`INTERRUPTED`) — pending question must be preserved
    runRow.status = "INTERRUPTED"
    await settleRunQuestionsOnFinalize(prisma, { runId: runRow.id, terminalRunStatus: "INTERRUPTED", now })
    expect(items[0]?.status).toBe("PENDING")

    const result = await answerAgentQuestion({
      prisma,
      itemId: qId,
      userId: "user-1",
      answerText: "US-East",
      now,
    })

    expect(result.delivery).toBe("continuation_run")
    expect(result.runId).toBe("22222222-2222-4222-8222-222222222222")
    expect(mocks.startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        workspaceId: "ws-1",
        userId: "user-1",
        message: expect.stringContaining("US-East"),
      }),
      undefined,
    )
  })

  it("clears lingering PENDING questions when a run SUCCEEDED or CANCELED", async () => {
    await postAgentRunQuestions({
      prisma,
      runId: runRow.id,
      rawToken: "worker-tok",
      nativeToolUseId: "chat-ask-4",
      questions: [{ question: "Stale?" }],
      now,
    })
    await settleRunQuestionsOnFinalize(prisma, { runId: runRow.id, terminalRunStatus: "CANCELED", now })
    expect(items[0]?.status).toBe("CLEARED")
  })
})
