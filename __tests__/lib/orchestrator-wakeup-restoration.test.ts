import { expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { processDueOrchestratorWakeups } from "@/lib/orchestrator/wakeups"

it("restores only the claimed generation when a new wake-up supersedes another row during dispatch", async () => {
  const now = new Date("2026-11-20T12:00:00Z")
  const batch = ["superseded", "unchanged"].map(id => ({
    id, orchestratorId: "orch", workspaceId: "workspace", targetConversationId: id,
    eventStatus: "DONE", targetUpdatedAtIso: now.toISOString(), generation: 1,
    busyRetries: 0, state: "BATCH_WAIT", dispatchedRunId: null,
  }))
  const rows = batch.map(row => ({ ...row }))
  const updateMany = vi.fn(async ({ where, data }: {
    where: { id?: string; OR?: { id: string; generation: number }[]; generation?: number; state?: string | { in: string[] }; dispatchedRunId?: null }
    data: { state: string }
  }) => {
    const matches = rows.filter(row => {
      const generations = where.OR ?? [{ id: where.id, generation: where.generation }]
      return generations.some(key => key.id === row.id && key.generation === row.generation)
        && (typeof where.state === "string" ? row.state === where.state : where.state?.in.includes(row.state))
        && (where.dispatchedRunId === undefined || row.dispatchedRunId === where.dispatchedRunId)
    })
    for (const row of matches) row.state = data.state
    return { count: matches.length }
  })
  const prisma = {
    agentOrchestratorWakeup: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(batch), updateMany },
    agentOrchestrator: { findFirst: vi.fn().mockResolvedValue({
      id: "orch", workspaceId: "workspace", userId: "owner", scopeType: "WORKSPACE",
      conversationId: "orchestrator-thread", enabled: true, wakeOnActivity: true,
    }) },
    agentConversation: {
      findFirst: vi.fn().mockResolvedValue({ id: "orchestrator-thread", archivedAt: null }),
      findMany: vi.fn().mockResolvedValue(batch.map(({ id }) => ({ id, title: id, updatedAt: now }))),
    },
    agentRun: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as AppPrismaClient
  const startContinuation = vi.fn(async () => {
    expect(rows.map(row => row.state)).toEqual(["DISPATCHED", "DISPATCHED"])
    Object.assign(rows[0], { generation: 2, state: "DISPATCHED" })
    return { status: "already_running" as const, conversationId: "orchestrator-thread" }
  })

  const result = await processDueOrchestratorWakeups({ prisma, now, startContinuation })

  expect(startContinuation).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ heldBusy: 1, dropped: 0 })
  expect(rows[0]).toMatchObject({ generation: 2, state: "DISPATCHED" })
  expect(rows[1]).toMatchObject({ generation: 1, state: "BATCH_WAIT" })
})
