/**
 * The durable-run control plane (lib/agent-runs.ts).
 *
 * The three load-bearing properties named in that file's header are what these
 * tests exist to hold down, because each one is the difference between a
 * detached run and a corrupted conversation:
 *
 *  1. event ingestion is idempotent on `(runId, seq)`;
 *  2. terminal transitions are first-write-wins, claimed *before* any side effect;
 *  3. audit rows are derived from newly-accepted events only.
 *
 * The worker credential checks are here for the same reason: this is the one
 * bearer token that reaches Compass from outside any session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockStopSandbox = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({ stopSandboxByName: (name: string) => mockStopSandbox(name) }))
const mockRevokeKey = vi.fn()
vi.mock("@/lib/agent-mcp-key", () => ({ revokeAgentMcpKey: (id: string) => mockRevokeKey(id) }))
const mockFinishClaim = vi.fn()
const mockReportFailure = vi.fn()
vi.mock("@/lib/pm-agent-service", () => ({
  finishInterviewProcessing: (...args: unknown[]) => mockFinishClaim(...args),
  reportPmAgentFailure: (...args: unknown[]) => mockReportFailure(...args),
}))

import {
  AGENT_RUN_HEARTBEAT_TIMEOUT_MS,
  AgentRunError,
  DEFAULT_AGENT_RUN_BUDGET_MS,
  MAX_AGENT_RUN_BUDGET_MS,
  MAX_AGENT_RUN_CALLBACK_EVENTS,
  MIN_AGENT_RUN_BUDGET_MS,
  agentRunFailureMessage,
  agentConversationSandboxName,
  agentRunSandboxName,
  agentRunWorkerTokenIsBound,
  agentRunsAvailable,
  appendAgentRunEvents,
  createAgentRun,
  createAgentRunCredential,
  deriveAgentRunAuditRows,
  finalizeAgentRun,
  hashAgentRunWorkerToken,
  isTerminalAgentRunStatus,
  markAgentRunStarted,
  reapIdleConversationSandboxes,
  resetAgentRunsAvailabilityCache,
  resolveAgentRunBudgetMs,
  sweepAgentRuns,
} from "@/lib/agent-runs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const NOW = new Date("2026-09-25T12:00:00.000Z")
const RUN_ID = "11111111-1111-4111-8111-111111111111"
const TOKEN = "t".repeat(43)

/** A run row as `AGENT_RUN_AUTH_SELECT` sees it. */
function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: "c-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: "RUNNING",
    kind: "CHAT",
    claimId: null as string | null,
    apiKeyId: "key-1" as string | null,
    sandboxName: agentRunSandboxName(RUN_ID),
    packProvenance: "[]",
    model: null as string | null,
    workerTokenHash: hashAgentRunWorkerToken(TOKEN),
    deadlineAt: new Date(NOW.getTime() + 60_000),
    lastSeq: 0,
    eventCount: 0,
    payloadBytes: 0,
    ...overrides,
  }
}

/** Stub prisma: only the delegates the function under test actually touches. */
function fakePrisma(overrides: Record<string, Any> = {}) {
  const prisma: Any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    agentSandboxOperation: { findUnique: vi.fn().mockResolvedValue(null) },
    agentRun: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRunEvent: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({}) },
    agentMessage: { create: vi.fn().mockResolvedValue({}) },
    agentConversation: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentAuditLog: { createMany: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
  prisma.$transaction = (fn: (tx: Any) => Promise<unknown>) => fn(prisma)
  return prisma
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentRunsAvailabilityCache()
})

describe("worker credential", () => {
  it("mints a 43-char base64url token and stores only its sha256", () => {
    const { rawToken, tokenHash } = createAgentRunCredential()
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenHash).not.toContain(rawToken)
    expect(hashAgentRunWorkerToken(rawToken)).toBe(tokenHash)
  })

  it("binds only a live run: wrong token, terminal status, and a passed deadline all fail", () => {
    const bound = { rawToken: TOKEN, expectedTokenHash: hashAgentRunWorkerToken(TOKEN), status: "RUNNING", deadlineAt: new Date(NOW.getTime() + 1), now: NOW }
    expect(agentRunWorkerTokenIsBound(bound)).toBe(true)
    expect(agentRunWorkerTokenIsBound({ ...bound, rawToken: "x".repeat(43) })).toBe(false)
    for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"]) {
      expect(agentRunWorkerTokenIsBound({ ...bound, status })).toBe(false)
    }
    expect(agentRunWorkerTokenIsBound({ ...bound, deadlineAt: NOW })).toBe(false)
    // A malformed stored hash must fail closed rather than reach timingSafeEqual
    // with mismatched buffer lengths (which throws).
    expect(agentRunWorkerTokenIsBound({ ...bound, expectedTokenHash: "" })).toBe(false)
    expect(agentRunWorkerTokenIsBound({ ...bound, expectedTokenHash: "not-a-hash" })).toBe(false)
  })

  it("derives the sandbox name from the run id so the sweeper never needs the column", () => {
    expect(agentRunSandboxName(RUN_ID)).toBe(`compass-agent-run-${RUN_ID}`)
  })
})

describe("resolveAgentRunBudgetMs", () => {
  it("defaults, clamps to the floor and ceiling, and floors fractions", () => {
    expect(resolveAgentRunBudgetMs(undefined)).toBe(DEFAULT_AGENT_RUN_BUDGET_MS)
    expect(resolveAgentRunBudgetMs(null)).toBe(DEFAULT_AGENT_RUN_BUDGET_MS)
    expect(resolveAgentRunBudgetMs(1)).toBe(MIN_AGENT_RUN_BUDGET_MS)
    expect(resolveAgentRunBudgetMs(24 * 3_600_000)).toBe(MAX_AGENT_RUN_BUDGET_MS)
    expect(resolveAgentRunBudgetMs(300_000.9)).toBe(300_000)
  })

  it("rejects a non-numeric or non-finite budget instead of silently defaulting", () => {
    for (const bad of ["600000", NaN, Infinity, {}, true]) {
      expect(() => resolveAgentRunBudgetMs(bad)).toThrow(AgentRunError)
    }
  })
})

describe("agentRunsAvailable", () => {
  const missingTable = Object.assign(new Error("table does not exist"), { code: "P2021" })

  it("reports false before migration 069 and caches the negative result", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockRejectedValue(missingTable)
    prisma.agentRunEvent.findFirst.mockRejectedValue(missingTable)
    expect(await agentRunsAvailable(prisma)).toBe(false)
    expect(await agentRunsAvailable(prisma)).toBe(false)
    // Second call served from cache: one probe pair, not two.
    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })

  it("caches a positive result permanently — the migration cannot be un-applied", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockResolvedValue(null)
    prisma.agentRunEvent.findFirst.mockResolvedValue(null)
    expect(await agentRunsAvailable(prisma)).toBe(true)
    expect(await agentRunsAvailable(prisma)).toBe(true)
    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })

  it("rethrows anything that is not a missing table, so a real fault is not read as 'pre-migration'", async () => {
    const prisma = fakePrisma()
    const outage = Object.assign(new Error("connection reset"), { code: "P1001" })
    prisma.agentRun.findFirst.mockRejectedValue(outage)
    prisma.agentRunEvent.findFirst.mockRejectedValue(outage)
    await expect(agentRunsAvailable(prisma)).rejects.toBe(outage)
  })
})

describe("createAgentRun", () => {
  it("creates a QUEUED run with a hashed token and a deadline one budget out", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockResolvedValue(null)
    prisma.agentRun.create.mockImplementation(({ data }: Any) => Promise.resolve(data))

    const { run, workerToken, sandboxName } = await createAgentRun({
      prisma,
      conversationId: "c-1",
      workspaceId: "ws-1",
      userId: "user-1",
      now: NOW,
    })

    const data = prisma.agentRun.create.mock.calls[0][0].data
    expect(data.status).toBe("QUEUED")
    expect(data.deadlineAt.getTime()).toBe(NOW.getTime() + DEFAULT_AGENT_RUN_BUDGET_MS)
    // The raw token is returned to the caller and never persisted.
    expect(data.workerTokenHash).toBe(hashAgentRunWorkerToken(workerToken))
    expect(JSON.stringify(data)).not.toContain(workerToken)
    expect(sandboxName).toBe(agentRunSandboxName(run.id))
  })

  it("records the model the run will use at creation, and nothing when none is given", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockResolvedValue(null)
    prisma.agentRun.create.mockImplementation(({ data }: Any) => Promise.resolve(data))
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1", model: "claude-opus-9", now: NOW })
    expect(prisma.agentRun.create.mock.calls[0][0].data.model).toBe("claude-opus-9")
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1", now: NOW })
    expect(prisma.agentRun.create.mock.calls[1][0].data).not.toHaveProperty("model")
  })

  it("refuses a second non-terminal run for the same conversation with 409 RUN_IN_FLIGHT", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockResolvedValue({ id: "other", status: "RUNNING", deadlineAt: NOW })
    await expect(createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toMatchObject({ status: 409, code: "RUN_IN_FLIGHT" })
    expect(prisma.agentRun.create).not.toHaveBeenCalled()
    // The check and the insert share one transaction, or the invariant is a race.
    expect(prisma.agentRun.findFirst.mock.calls[0][0].where.status.in).toEqual(["QUEUED", "RUNNING"])
  })

  it("writes the conversation latch before the in-flight check, inside the same transaction", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findFirst.mockResolvedValue(null)
    prisma.agentRun.create.mockResolvedValue({ id: "run-1" })
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1", now: NOW })
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1)
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.agentRun.findFirst.mock.invocationCallOrder[0])
  })

  it("rejects a kind that is neither CHAT nor a registered handoff", async () => {
    const prisma = fakePrisma()
    await expect(createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1", kind: "ARBITRARY" as Any }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_RUN_KIND" })
  })
})

describe("markAgentRunStarted", () => {
  it("only advances a run that is still QUEUED, and records what has to be cleaned up", async () => {
    const prisma = fakePrisma()
    expect(await markAgentRunStarted({ prisma, runId: RUN_ID, apiKeyId: "key-1", now: NOW })).toBe(true)
    const call = prisma.agentRun.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: RUN_ID, status: "QUEUED" })
    expect(call.data).toMatchObject({ status: "RUNNING", apiKeyId: "key-1", sandboxName: agentRunSandboxName(RUN_ID) })
    // A canceled-before-start run loses the race and stays canceled.
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 })
    expect(await markAgentRunStarted({ prisma, runId: RUN_ID })).toBe(false)
  })
})

describe("appendAgentRunEvents", () => {
  function ingest(prisma: Any, events: Any[], rawToken = TOKEN) {
    return appendAgentRunEvents({ prisma, runId: RUN_ID, rawToken, events, now: NOW })
  }

  it("rejects an unauthorized worker before touching the event log", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await expect(ingest(prisma, [{ seq: 1, type: "agent", payload: {} }], "x".repeat(43)))
      .rejects.toMatchObject({ status: 401, code: "INVALID_WORKER_TOKEN" })
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
  })

  it("validates the batch shape before authorizing, so a malformed callback is cheap", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    const cases: [Any[], string][] = [
      [[], "CALLBACK_BATCH_TOO_LARGE"],
      [Array.from({ length: MAX_AGENT_RUN_CALLBACK_EVENTS + 1 }, (_, i) => ({ seq: i + 1, type: "agent", payload: {} })), "CALLBACK_BATCH_TOO_LARGE"],
      [[{ seq: 0, type: "agent", payload: {} }], "INVALID_EVENT_SEQ"],
      [[{ seq: 1.5, type: "agent", payload: {} }], "INVALID_EVENT_SEQ"],
      [[{ seq: 1, type: "agent", payload: {} }, { seq: 1, type: "agent", payload: {} }], "DUPLICATE_EVENT_SEQ"],
      [[{ seq: 1, type: "sneaky", payload: {} }], "INVALID_EVENT_TYPE"],
      [[{ seq: 1, type: "agent", payload: { blob: "x".repeat(300_000) } }], "CALLBACK_PAYLOAD_TOO_LARGE"],
    ]
    for (const [events, code] of cases) {
      await expect(ingest(prisma, events)).rejects.toMatchObject({ code })
    }
  })

  it("is idempotent on (runId, seq): a replayed batch accepts nothing and advances nothing", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ lastSeq: 2, eventCount: 2 }))
    prisma.agentRunEvent.findMany.mockResolvedValue([{ seq: 1 }, { seq: 2 }])

    const result = await ingest(prisma, [
      { seq: 1, type: "agent", payload: {} },
      { seq: 2, type: "agent", payload: {} },
    ])

    expect(result).toEqual({ acceptedSeqs: [], replayedSeqs: [1, 2], lastSeq: 2, status: "RUNNING" })
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled()
  })

  it("accepts only the fresh half of a partially-replayed batch and advances lastSeq to its max", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ lastSeq: 2, eventCount: 2 }))
    prisma.agentRunEvent.findMany.mockResolvedValue([{ seq: 2 }])

    const result = await ingest(prisma, [
      { seq: 2, type: "agent", payload: {} },
      { seq: 3, type: "status", payload: { phase: "running" } },
      { seq: 4, type: "agent", payload: {} },
    ])

    expect(result.acceptedSeqs).toEqual([3, 4])
    expect(result.replayedSeqs).toEqual([2])
    expect(result.lastSeq).toBe(4)
    expect(prisma.agentRunEvent.createMany.mock.calls[0][0].data.map((row: Any) => row.seq)).toEqual([3, 4])
    // Fenced on every counter it reads, so two concurrent callbacks cannot both win.
    expect(prisma.agentRun.updateMany.mock.calls[0][0].where).toMatchObject({ id: RUN_ID, status: "RUNNING", lastSeq: 2, eventCount: 2, payloadBytes: 0 })
  })

  it("reports a lost compare-and-swap as 409 CALLBACK_RACE rather than silently dropping events", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 })
    await expect(ingest(prisma, [{ seq: 1, type: "agent", payload: {} }])).rejects.toMatchObject({ status: 409, code: "CALLBACK_RACE" })
  })

  it("refuses to grow a transcript past the per-run event cap", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ eventCount: 2_000 }))
    await expect(ingest(prisma, [{ seq: 2_001, type: "agent", payload: {} }])).rejects.toMatchObject({ status: 409, code: "RUN_EVENT_LIMIT" })
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
  })

  it("writes audit rows for newly-accepted mutations only, inheriting exactly-once from the insert", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    prisma.agentRunEvent.findMany.mockResolvedValue([{ seq: 1 }])
    const mutation = { message: { message: { content: [{ type: "tool_use", name: "mcp__compass__create_task", input: { title: "t" } }] } } }
    const read = { message: { message: { content: [{ type: "tool_use", name: "mcp__compass__list_tasks", input: {} }] } } }

    await ingest(prisma, [
      { seq: 1, type: "agent", payload: mutation }, // replayed — must not be audited twice
      { seq: 2, type: "agent", payload: mutation },
      { seq: 3, type: "agent", payload: read },
    ])

    const rows = prisma.agentAuditLog.createMany.mock.calls[0][0].data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: "user-1", workspaceId: "ws-1", conversationId: "c-1", toolName: "create_task" })
    expect(rows[0].argsSummary).toBe(JSON.stringify({ title: "t" }))
  })

  it("redacts tool arguments on a claimed handoff run", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ kind: "PM_INTERVIEW", claimId: "claim-1" }))
    await ingest(prisma, [{ seq: 1, type: "agent", payload: { message: { message: { content: [{ type: "tool_use", name: "mcp__compass__update_opportunity", input: { secret: "x" } }] } } } }])
    expect(prisma.agentAuditLog.createMany.mock.calls[0][0].data[0].argsSummary).toBeNull()
  })
})

describe("deriveAgentRunAuditRows", () => {
  it("keeps mutations, drops reads, and truncates arguments at 1000 chars", () => {
    const payload = {
      message: {
        message: {
          content: [
            { type: "text", text: "thinking" },
            { type: "tool_use", name: "mcp__compass__list_opportunities", input: {} },
            { type: "tool_use", name: "mcp__compass__create_opportunity", input: { note: "y".repeat(5_000) } },
          ],
        },
      },
    }
    const rows = deriveAgentRunAuditRows(payload, false)
    expect(rows.map((row) => row.toolName)).toEqual(["create_opportunity"])
    expect(rows[0].argsSummary!.length).toBe(1_000)
  })

  it("returns nothing for a payload with no tool calls, whatever shape it is", () => {
    for (const payload of [null, undefined, {}, { message: { message: { content: "nope" } } }]) {
      expect(deriveAgentRunAuditRows(payload, false)).toEqual([])
    }
  })
})

describe("finalizeAgentRun", () => {
  const cleanup = { stopSandbox: mockStopSandbox, revokeKey: mockRevokeKey, finishClaim: mockFinishClaim }

  it("claims the terminal status, then writes the transcript and cleans up", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())

    const result = await finalizeAgentRun({
      prisma,
      runId: RUN_ID,
      status: "SUCCEEDED",
      text: "Here is your answer.",
      usage: { durationMs: 1_000, numTurns: 2, totalCostUsd: 0.01, usage: { input_tokens: 10, output_tokens: 20 } },
      now: NOW,
      cleanup,
    })

    expect(result).toEqual({ finalized: true, status: "SUCCEEDED" })
    expect(prisma.agentRun.updateMany.mock.calls[0][0].where.status.in).toEqual(["QUEUED", "RUNNING"])
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ role: "assistant", content: "Here is your answer.", inputTokens: 10, outputTokens: 20 })
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
    expect(mockStopSandbox).toHaveBeenCalledWith(agentRunSandboxName(RUN_ID))
    expect(prisma.agentRun.update.mock.calls[0][0].data).toMatchObject({ sandboxStoppedAt: NOW })
  })

  it("links the assistant message to its run, so spend can be counted once (ADR-0032)", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "ok", usage: { totalCostUsd: 0.5 }, now: NOW, cleanup })
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ runId: RUN_ID, costUsd: 0.5 })
  })

  it("keeps the cost of a FAILED run that reported usage, on both the run and its message", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "FAILED", error: "max turns", usage: { totalCostUsd: 0.4, numTurns: 9 }, now: NOW, cleanup })
    expect(prisma.agentRun.updateMany.mock.calls[0][0].data).toMatchObject({ status: "FAILED", costUsd: 0.4 })
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ runId: RUN_ID, costUsd: 0.4, numTurns: 9 })
  })

  it("leaves cost null (never zero) when a run is swept without any usage", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "INTERRUPTED", error: "stale", now: NOW, cleanup })
    expect(prisma.agentRun.updateMany.mock.calls[0][0].data.costUsd).toBeNull()
    const data = prisma.agentMessage.create.mock.calls[0][0].data
    expect(data.runId).toBe(RUN_ID)
    expect(data).not.toHaveProperty("costUsd")
  })

  it("does nothing at all when the run is already terminal", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ status: "SUCCEEDED" }))
    expect(await finalizeAgentRun({ prisma, runId: RUN_ID, status: "INTERRUPTED", now: NOW, cleanup })).toEqual({ finalized: false, status: "SUCCEEDED" })
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled()
    expect(prisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockRevokeKey).not.toHaveBeenCalled()
  })

  it("is first-write-wins: losing the fenced update writes no message and revokes nothing", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique
      .mockResolvedValueOnce(runRow())
      .mockResolvedValueOnce({ status: "SUCCEEDED" })
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 })

    // The sweeper arriving a millisecond after a real result must not produce a
    // second assistant message or a double revocation.
    expect(await finalizeAgentRun({ prisma, runId: RUN_ID, status: "INTERRUPTED", now: NOW, cleanup })).toEqual({ finalized: false, status: "SUCCEEDED" })
    expect(prisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockRevokeKey).not.toHaveBeenCalled()
    expect(mockStopSandbox).not.toHaveBeenCalled()
  })

  it("still cleans up when the transcript write fails", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    prisma.agentMessage.create.mockRejectedValue(new Error("conversation deleted"))
    await expect(finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "hi", now: NOW, cleanup })).resolves.toMatchObject({ finalized: true })
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
    expect(mockStopSandbox).toHaveBeenCalled()
  })

  it("keeps each cleanup step independent — a failed sandbox stop still revoked the key", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    mockStopSandbox.mockRejectedValue(new Error("sandbox already gone"))
    await expect(finalizeAgentRun({ prisma, runId: RUN_ID, status: "FAILED", error: "boom", now: NOW, cleanup })).resolves.toMatchObject({ finalized: true })
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
    // Unconfirmed stop, so the row must not claim the sandbox was stopped.
    expect(prisma.agentRun.update).not.toHaveBeenCalled()
  })

  it("keeps the model recorded at creation instead of overwriting it with a constant, on the run and on the reply", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ model: "claude-opus-9" }))
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "done", now: NOW, cleanup })
    expect(prisma.agentRun.updateMany.mock.calls[0][0].data).not.toHaveProperty("model")
    expect(prisma.agentMessage.create.mock.calls[0][0].data.model).toBe("claude-opus-9")
  })

  it("falls back to the default model label only for a run that never recorded one", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "done", now: NOW, cleanup })
    expect(prisma.agentRun.updateMany.mock.calls[0][0].data.model).toBe("claude-sonnet-5")
    expect(prisma.agentMessage.create.mock.calls[0][0].data.model).toBe("claude-sonnet-5")
  })

  it("finishes a handoff claim with the run's outcome", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ kind: "PM_INTERVIEW", claimId: "claim-1" }))
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "done", now: NOW, cleanup })
    expect(mockFinishClaim).toHaveBeenCalledWith("c-1", "claim-1", true)
    expect(mockReportFailure).not.toHaveBeenCalled()
  })

  it("reports a failed handoff and marks the claim unsuccessful", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ kind: "PM_INTERVIEW", claimId: "claim-1" }))
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "INTERRUPTED", error: "swept", now: NOW, cleanup })
    expect(mockFinishClaim).toHaveBeenCalledWith("c-1", "claim-1", false)
    expect(mockReportFailure).toHaveBeenCalled()
  })

  it("rejects a worker token that does not match, even to record a result", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow())
    await expect(finalizeAgentRun({ prisma, runId: RUN_ID, rawToken: "x".repeat(43), status: "SUCCEEDED", text: "hi", now: NOW, cleanup }))
      .rejects.toMatchObject({ status: 401, code: "INVALID_WORKER_TOKEN" })
  })

  it("lets a run that overran its deadline by seconds still record its result", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(runRow({ deadlineAt: new Date(NOW.getTime() - 5_000) }))
    await expect(finalizeAgentRun({ prisma, runId: RUN_ID, rawToken: TOKEN, status: "SUCCEEDED", text: "just made it", now: NOW, cleanup }))
      .resolves.toMatchObject({ finalized: true })
  })

  it("404s a run that does not exist", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockResolvedValue(null)
    await expect(finalizeAgentRun({ prisma, runId: RUN_ID, status: "CANCELED", now: NOW, cleanup })).rejects.toMatchObject({ status: 404, code: "RUN_NOT_FOUND" })
  })
})

describe("agentRunFailureMessage", () => {
  it("uses the handoff policy's message for a handoff kind, so the PM surface reads the same as before", () => {
    expect(agentRunFailureMessage("PM_INTERVIEW", "FAILED", "raw internal detail")).not.toContain("raw internal detail")
  })
  it("distinguishes interrupted, canceled, and failed chat turns", () => {
    expect(agentRunFailureMessage("CHAT", "INTERRUPTED", "budget")).toBe("Agent run was interrupted: budget")
    expect(agentRunFailureMessage("CHAT", "CANCELED")).toBe("Agent run was canceled.")
    expect(agentRunFailureMessage("CHAT", "FAILED", null)).toBe("Agent turn failed: no further detail was reported")
  })
})

describe("sweepAgentRuns", () => {
  it("separates a blown deadline from a dead worker, and reports truncation", async () => {
    const stale = new Date(NOW.getTime() - AGENT_RUN_HEARTBEAT_TIMEOUT_MS - 1_000)
    const prisma = fakePrisma()
    prisma.agentRun.findMany.mockResolvedValue([
      { id: "run-deadline", deadlineAt: new Date(NOW.getTime() - 1), lastHeartbeatAt: NOW, statusChangedAt: NOW },
      { id: "run-silent", deadlineAt: new Date(NOW.getTime() + 600_000), lastHeartbeatAt: stale, statusChangedAt: stale },
    ])
    prisma.agentRun.findUnique.mockImplementation(({ where }: Any) => Promise.resolve(runRow({ id: where.id, apiKeyId: null, sandboxName: null })))

    const result = await sweepAgentRuns({ prisma, now: NOW, limit: 2, cleanup: { stopSandbox: mockStopSandbox, revokeKey: mockRevokeKey, finishClaim: mockFinishClaim } })

    expect(result.examined).toBe(2)
    expect(result.swept).toEqual([
      { runId: "run-deadline", reason: "DEADLINE_EXPIRED" },
      { runId: "run-silent", reason: "HEARTBEAT_STALE" },
    ])
    expect(result.failed).toEqual([])
    // `examined === limit` is how the caller learns the batch was cut short.
    expect(result.truncated).toBe(true)
    // A QUEUED orphan has no sandboxName column yet; the name is derived so it is
    // still reachable.
    expect(mockStopSandbox).toHaveBeenCalledWith(agentRunSandboxName("run-deadline"))
  })

  it("collects a QUEUED orphan off statusChangedAt when it never heartbeat at all", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findMany.mockResolvedValue([])
    await sweepAgentRuns({ prisma, now: NOW })
    const or = prisma.agentRun.findMany.mock.calls[0][0].where.OR
    expect(or).toEqual([
      { deadlineAt: { lte: NOW } },
      { lastHeartbeatAt: { lte: new Date(NOW.getTime() - AGENT_RUN_HEARTBEAT_TIMEOUT_MS) } },
      { lastHeartbeatAt: null, statusChangedAt: { lte: new Date(NOW.getTime() - AGENT_RUN_HEARTBEAT_TIMEOUT_MS) } },
    ])
  })

  it("records a run it could not finalize and keeps sweeping the rest", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findMany.mockResolvedValue([
      { id: "run-bad", deadlineAt: new Date(NOW.getTime() - 1), lastHeartbeatAt: NOW, statusChangedAt: NOW },
      { id: "run-ok", deadlineAt: new Date(NOW.getTime() - 1), lastHeartbeatAt: NOW, statusChangedAt: NOW },
    ])
    prisma.agentRun.findUnique.mockImplementation(({ where }: Any) =>
      where.id === "run-bad" ? Promise.reject(new Error("db blip")) : Promise.resolve(runRow({ id: where.id })))

    const result = await sweepAgentRuns({ prisma, now: NOW, limit: 25, cleanup: { stopSandbox: mockStopSandbox, revokeKey: mockRevokeKey, finishClaim: mockFinishClaim } })
    expect(result.failed).toEqual([{ runId: "run-bad", error: "db blip" }])
    expect(result.swept).toEqual([{ runId: "run-ok", reason: "DEADLINE_EXPIRED" }])
    expect(result.truncated).toBe(false)
  })
})

describe("isTerminalAgentRunStatus", () => {
  it("treats only the four end states as terminal, and an unknown string as non-terminal", () => {
    expect(["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"].every(isTerminalAgentRunStatus)).toBe(true)
    expect(["QUEUED", "RUNNING", "", "PENDING"].some(isTerminalAgentRunStatus)).toBe(false)
  })
})

function fakePersistentSandboxPrisma() {
  let operation: Any = null
  const matches = (where: Record<string, unknown>) =>
    operation && Object.entries(where).every(([key, value]) => operation[key] === value)
  const prisma = fakePrisma({
    agentSandboxOperation: {
      findUnique: vi.fn(async () => operation),
      create: vi.fn(async ({ data }) => operation = data),
      update: vi.fn(async ({ data }) => operation = { ...operation, ...data }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!matches(where)) return { count: 0 }
        operation = { ...operation, ...data }
        return { count: 1 }
      }),
      deleteMany: vi.fn(async ({ where }) => {
        if (!matches(where)) return { count: 0 }
        operation = null
        return { count: 1 }
      }),
    },
  })
  prisma.agentRun.findUnique.mockResolvedValue({ sandboxStoppedAt: null })
  return prisma
}

describe("reapIdleConversationSandboxes", () => {
  const CONV = agentConversationSandboxName("c-1")
  const idleFor = (ms: number) => new Date(NOW.getTime() - ms)
  const candidate = (over: Record<string, unknown> = {}) => ({ id: "run-a", conversationId: "c-1", sandboxName: CONV, createdAt: idleFor(7 * 60_000), finishedAt: idleFor(6 * 60_000), ...over })
  const cleanup = { stopSandbox: mockStopSandbox }
  // Earlier tests leave a rejecting implementation on the shared mock; clearAllMocks keeps implementations.
  beforeEach(() => mockStopSandbox.mockReset().mockResolvedValue(undefined))

  it("reaps a conversation with several finished turns: the newest run decides, even though the older ones each have a newer run", async () => {
    // Three SUCCEEDED turns left warm on one sandbox, oldest first (the sweeper orders by finishedAt ascending).
    const prisma = fakePersistentSandboxPrisma()
    prisma.$queryRaw.mockResolvedValue([
      candidate({ id: "run-1", finishedAt: idleFor(40 * 60_000) }),
      candidate({ id: "run-2", finishedAt: idleFor(30 * 60_000) }),
      candidate({ id: "run-3", finishedAt: idleFor(20 * 60_000) }),
    ])
    // run-1 and run-2 each have a newer run; run-3 has none.
    prisma.agentRun.findFirst.mockImplementation(({ where }: Any) => Promise.resolve(where.id.not !== "run-3" ? { id: "newer" } : null))
    const result = await reapIdleConversationSandboxes({ prisma, now: NOW, cleanup })
    expect(mockStopSandbox).toHaveBeenCalledTimes(1)
    expect(mockStopSandbox).toHaveBeenCalledWith(CONV)
    expect(result).toMatchObject({ examined: 3, stopped: [CONV], failed: [] })
  })

  it("never stops the sandbox while a later run exists", async () => {
    const prisma = fakePersistentSandboxPrisma()
    prisma.$queryRaw.mockResolvedValue([candidate({ id: "run-1" }), candidate({ id: "run-2" })])
    prisma.agentRun.findFirst.mockResolvedValue({ id: "run-3-active" })
    const result = await reapIdleConversationSandboxes({ prisma, now: NOW, cleanup })
    expect(mockStopSandbox).not.toHaveBeenCalled()
    expect(result.stopped).toEqual([])
  })
})

describe("persistent sandbox stop fencing", () => {
  const sandboxName = agentConversationSandboxName("c-1")
  const finishedAt = new Date(NOW.getTime() - 20 * 60_000)

  function idleRun() {
    const prisma = fakePersistentSandboxPrisma()
    prisma.$queryRaw.mockResolvedValue([{ id: RUN_ID, conversationId: "c-1", sandboxName, createdAt: finishedAt, finishedAt, status: "SUCCEEDED" }])
    prisma.agentRun.findFirst.mockResolvedValue(null)
    prisma.agentRun.create.mockImplementation(({ data }: Any) => Promise.resolve(data))
    return prisma
  }

  it("holds off a queued launch while the stop can still affect the named sandbox", async () => {
    const prisma = idleRun()
    const dispatched = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const stopSandbox = vi.fn(async () => {
      dispatched.resolve()
      await response.promise
    })
    const sweep = reapIdleConversationSandboxes({ prisma, now: NOW, cleanup: { stopSandbox } })
    try {
      await Promise.race([dispatched.promise, sweep.then(() => { throw new Error("stop did not start") })])
      await expect(createAgentRun({
        prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "user-1", now: NOW,
      })).rejects.toMatchObject({ status: 409 })
      expect(prisma.agentRun.create).not.toHaveBeenCalled()
    } finally {
      response.resolve()
      await sweep
    }
  })

  it("sends only one stop when two sweepers observe the same idle run", async () => {
    const prisma = idleRun()
    const dispatched = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const stopSandbox = vi.fn(async () => {
      if (stopSandbox.mock.calls.length > 1) return
      dispatched.resolve()
      await response.promise
    })
    const sweep = reapIdleConversationSandboxes({ prisma, now: NOW, cleanup: { stopSandbox } })
    try {
      await Promise.race([dispatched.promise, sweep.then(() => { throw new Error("stop did not start") })])
      const second = await reapIdleConversationSandboxes({ prisma, now: NOW, cleanup: { stopSandbox } })
      expect(second.stopped).toEqual([])
      expect(stopSandbox).toHaveBeenCalledTimes(1)
    } finally {
      response.resolve()
      await sweep
    }
  })
})
