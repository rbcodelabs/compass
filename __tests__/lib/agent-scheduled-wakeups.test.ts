import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

const mocks = vi.hoisted(() => ({
  findActiveRun: vi.fn(),
  resolveAccess: vi.fn(),
  startContinuation: vi.fn(),
}))

vi.mock("@/lib/agent-runs", async (original) => ({
  ...(await original<object>()),
  findActiveAgentRun: (...args: unknown[]) => mocks.findActiveRun(...args),
}))

vi.mock("@/lib/agent-conversation-access", () => ({
  resolveConversationAccess: (...args: unknown[]) => mocks.resolveAccess(...args),
}))

vi.mock("@/lib/agent-continuation-run", () => ({
  startConversationContinuationRun: (...args: unknown[]) => mocks.startContinuation(...args),
}))

import {
  cancelConversationWakeup,
  clampWakeupDelaySeconds,
  fireDueAgentWakeups,
  scheduleAgentWakeup,
} from "@/lib/agent-scheduled-wakeups"

type StoredWakeup = {
  id: string
  workspaceId: string
  conversationId: string
  userId: string
  agentId: string | null
  sourceRunId: string | null
  fireAt: Date
  delaySeconds: number
  reason: string | null
  prompt: string
  status: string
  firedRunId: string | null
  failureReason: string | null
  createdAt: Date
  firedAt: Date | null
  canceledAt: Date | null
  updatedAt: Date
}

describe("lib/agent-scheduled-wakeups", () => {
  const t0 = new Date("2026-11-14T12:00:00.000Z")
  let rows: StoredWakeup[]
  let prisma: AppPrismaClient

  beforeEach(() => {
    vi.clearAllMocks()
    rows = []
    mocks.findActiveRun.mockResolvedValue(null)
    mocks.resolveAccess.mockResolvedValue({ role: "OWNER" })
    mocks.startContinuation.mockResolvedValue({
      status: "started",
      runId: "run-resumed-1",
      conversationId: "conv-1",
      launched: true,
    })

    let seq = 0
    prisma = {
      agentScheduledWakeup: {
        create: vi.fn(async ({ data }: { data: Omit<StoredWakeup, "id" | "firedRunId" | "failureReason" | "firedAt" | "canceledAt"> }) => {
          seq += 1
          const row: StoredWakeup = {
            id: `wakeup-${seq}`,
            firedRunId: null,
            failureReason: null,
            firedAt: null,
            canceledAt: null,
            ...data,
          }
          rows.push(row)
          return row
        }),
        findMany: vi.fn(async ({ where }: { where?: { status?: string; fireAt?: { lte: Date }; conversationId?: string } }) => {
          return rows.filter((r) => {
            if (where?.status && r.status !== where.status) return false
            if (where?.conversationId && r.conversationId !== where.conversationId) return false
            if (where?.fireAt?.lte && r.fireAt.getTime() > where.fireAt.lte.getTime()) return false
            return true
          })
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<StoredWakeup> }) => {
          let count = 0
          for (const r of rows) {
            if (where.id && r.id !== where.id) continue
            if (where.conversationId && r.conversationId !== where.conversationId) continue
            if (where.workspaceId && r.workspaceId !== where.workspaceId) continue
            if (where.status && r.status !== where.status) continue
            Object.assign(r, data)
            count += 1
          }
          return { count }
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<StoredWakeup> }) => {
          const found = rows.find((r) => r.id === where.id)
          if (found) Object.assign(found, data)
          return found
        }),
      },
      agentConversation: {
        update: vi.fn(async () => ({ id: "conv-1" })),
      },
    } as unknown as AppPrismaClient
  })

  it("clamps delaySeconds strictly into [60, 3600]", () => {
    expect(clampWakeupDelaySeconds(5)).toBe(60)
    expect(clampWakeupDelaySeconds(180)).toBe(180)
    expect(clampWakeupDelaySeconds(9_999)).toBe(3_600)
  })

  it("schedules inline timer for <= 240s, omits inline timer for > 240s, and cancels via stop: true", async () => {
    const inlineTimers: number[] = []
    const resolveTurnRun = async () => ({
      id: "run-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      userId: "user-1",
      agentId: null,
    })

    const short = await scheduleAgentWakeup(
      { delaySeconds: 10, reason: "CI build", prompt: "Check GitHub Actions" },
      {
        prisma,
        now: t0,
        resolveTurnRun,
        scheduleInlineTimer: (ms) => inlineTimers.push(ms),
      },
    )
    expect(short.content[0]?.text).toContain("Scheduled wake-up in 60s")
    expect(rows[0]?.delaySeconds).toBe(60)
    expect(inlineTimers).toEqual([60_000])

    // Scheduling a second wakeup (> 240s) cancels the previous PENDING one and leaves execution to cron
    await scheduleAgentWakeup(
      { delaySeconds: 600, reason: "Deploy check", prompt: "Verify prod health" },
      {
        prisma,
        now: t0,
        resolveTurnRun,
        scheduleInlineTimer: (ms) => inlineTimers.push(ms),
      },
    )
    expect(rows[0]?.status).toBe("CANCELED")
    expect(rows[1]?.status).toBe("PENDING")
    expect(rows[1]?.delaySeconds).toBe(600)
    expect(inlineTimers).toEqual([60_000]) // no second inline timer

    // stop: true cancels active pending wakeup
    await scheduleAgentWakeup({ stop: true }, { prisma, now: t0, resolveTurnRun })
    expect(rows[1]?.status).toBe("CANCELED")
  })

  it("defers firing while conversation still has an active run, then fires once idle", async () => {
    await scheduleAgentWakeup(
      { delaySeconds: 120, reason: "Poll deploy", prompt: "Check status" },
      {
        prisma,
        now: t0,
        resolveTurnRun: async () => ({
          id: "run-1",
          conversationId: "conv-1",
          workspaceId: "ws-1",
          userId: "user-1",
          agentId: "agent-9",
        }),
        scheduleInlineTimer: () => {},
      },
    )

    const tDue = new Date("2026-11-14T12:03:00.000Z")
    mocks.findActiveRun.mockResolvedValueOnce({ id: "run-1", status: "RUNNING" })
    const busySweep = await fireDueAgentWakeups({ prisma, now: tDue })
    expect(busySweep).toEqual({ scanned: 1, fired: 0, deferredBusy: 1, failed: 0 })
    expect(rows[0]?.status).toBe("PENDING")

    // Next tick: conversation is idle -> fires continuation run
    mocks.findActiveRun.mockResolvedValueOnce(null)
    const firedSweep = await fireDueAgentWakeups({ prisma, now: tDue })
    expect(firedSweep).toEqual({ scanned: 1, fired: 1, deferredBusy: 0, failed: 0 })
    expect(rows[0]?.status).toBe("FIRED")
    expect(rows[0]?.firedRunId).toBe("run-resumed-1")
    expect(mocks.startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        preferredAgentId: "agent-9",
        message: "[Scheduled wake-up — Poll deploy]\nCheck status",
      }),
      expect.any(Object),
    )
  })

  it("supports 1-click user cancellation via cancelConversationWakeup", async () => {
    await scheduleAgentWakeup(
      { delaySeconds: 300, reason: "Wait for preview", prompt: "Inspect URL" },
      {
        prisma,
        now: t0,
        resolveTurnRun: async () => ({
          id: "run-1",
          conversationId: "conv-1",
          workspaceId: "ws-1",
          userId: "user-1",
          agentId: null,
        }),
        scheduleInlineTimer: () => {},
      },
    )

    const canceled = await cancelConversationWakeup(prisma, {
      conversationId: "conv-1",
      workspaceId: "ws-1",
      userId: "user-1",
      wakeupId: rows[0]!.id,
      now: t0,
    })
    expect(canceled).toEqual({ canceledCount: 1 })
    expect(rows[0]?.status).toBe("CANCELED")
  })
})
