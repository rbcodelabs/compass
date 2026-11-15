import { describe, expect, it, vi } from "vitest"
import {
  BATCH_WINDOW_MS,
  QUIET_WAIT_MS,
  WORKSPACE_HEARTBEAT_PROMPT,
  buildOrchestratorWakeupPrompt,
  enqueueOrchestratorWakeupOnRunFinalize,
  processDueOrchestratorHeartbeats,
  processDueOrchestratorWakeups,
} from "./wakeups"

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"
const SQUAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORCH_CONV_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const TARGET_CONV_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

describe("enqueueOrchestratorWakeupOnRunFinalize", () => {
  it("skips self/loop wake-ups when the completed run belongs to an orchestrator conversation and promotes HELD_BUSY rows", async () => {
    const updateManyWakeup = vi.fn().mockResolvedValue({ count: 1 })
    const mockPrisma = {
      agentOrchestrator: {
        findFirst: vi.fn().mockResolvedValue({ id: "orch-1", workspaceId: WORKSPACE_ID }),
      },
      agentOrchestratorWakeup: {
        findMany: vi.fn().mockResolvedValue([{ id: "wake-held-1" }]),
        updateMany: updateManyWakeup,
      },
    }

    const res = await enqueueOrchestratorWakeupOnRunFinalize({
      prisma: mockPrisma as never,
      runId: "run-1",
      workspaceId: WORKSPACE_ID,
      conversationId: ORCH_CONV_ID,
      userId: USER_ID,
      status: "SUCCEEDED",
      now: new Date("2026-11-14T18:00:00.000Z"),
      disableInlineAfter: true,
    })

    expect(res).toEqual({ enqueued: false, reason: "orchestrator_self_run" })
    expect(updateManyWakeup).toHaveBeenCalledTimes(1)
  })

  it("never auto-creates a Workspace Orchestrator for unassigned threads", async () => {
    const mockPrisma = {
      agentOrchestrator: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      agentOrchestratorWakeup: {
        findFirst: vi.fn(),
      },
      agentConversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: TARGET_CONV_ID,
          squadId: null,
          archivedAt: null,
          updatedAt: new Date("2026-11-14T18:00:00.000Z"),
        }),
      },
    }

    const res = await enqueueOrchestratorWakeupOnRunFinalize({
      prisma: mockPrisma as never,
      runId: "run-2",
      workspaceId: WORKSPACE_ID,
      conversationId: TARGET_CONV_ID,
      userId: USER_ID,
      status: "SUCCEEDED",
      now: new Date("2026-11-14T18:00:00.000Z"),
      disableInlineAfter: true,
    })

    expect(res).toEqual({ enqueued: false, reason: "orchestrator_disabled_or_missing" })
    expect(mockPrisma.agentOrchestrator.create).not.toHaveBeenCalled()
  })

  it("auto-ensures a Squad Orchestrator on first completed Squad run and uses 60s QUIET_WAIT on SUCCEEDED vs 0s BATCH_WAIT on FAILED", async () => {
    const now = new Date("2026-11-14T18:00:00.000Z")
    const createWakeup = vi.fn().mockResolvedValue({ id: "wake-1" })
    const mockPrisma = {
      agentOrchestrator: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null) // selfOrch check
          .mockResolvedValueOnce(null), // existingSquadOrch check
        create: vi.fn().mockResolvedValue({
          id: "orch-squad-1",
          enabled: true,
          wakeOnActivity: true,
        }),
      },
      agentOrchestratorWakeup: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: createWakeup,
      },
      agentConversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: TARGET_CONV_ID,
          squadId: SQUAD_ID,
          archivedAt: null,
          updatedAt: now,
        }),
        create: vi.fn().mockResolvedValue({ id: ORCH_CONV_ID }),
      },
      squad: {
        findFirst: vi.fn().mockResolvedValue({ id: SQUAD_ID, name: "Core Platform" }),
      },
    }

    const okRes = await enqueueOrchestratorWakeupOnRunFinalize({
      prisma: mockPrisma as never,
      runId: "run-3",
      workspaceId: WORKSPACE_ID,
      conversationId: TARGET_CONV_ID,
      userId: USER_ID,
      status: "SUCCEEDED",
      now,
      disableInlineAfter: true,
    })

    expect(okRes).toEqual({
      enqueued: true,
      wakeupId: "wake-1",
      orchestratorId: "orch-squad-1",
      state: "QUIET_WAIT",
    })
    expect(createWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "QUIET_WAIT",
          eventStatus: "DONE",
          quietUntil: new Date(now.getTime() + QUIET_WAIT_MS),
          flushAfter: null,
        }),
      }),
    )

    // Now test FAILED -> immediate BATCH_WAIT (0s quiet wait + 12s flushAfter)
    mockPrisma.agentOrchestrator.findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "orch-squad-1",
        enabled: true,
        wakeOnActivity: true,
        conversationId: ORCH_CONV_ID,
      })
    const errRes = await enqueueOrchestratorWakeupOnRunFinalize({
      prisma: mockPrisma as never,
      runId: "run-4",
      workspaceId: WORKSPACE_ID,
      conversationId: TARGET_CONV_ID,
      userId: USER_ID,
      status: "FAILED",
      now,
      disableInlineAfter: true,
    })
    expect(errRes).toEqual({
      enqueued: true,
      wakeupId: "wake-1",
      orchestratorId: "orch-squad-1",
      state: "BATCH_WAIT",
    })
    expect(createWakeup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "BATCH_WAIT",
          eventStatus: "ERROR",
          quietUntil: now,
          flushAfter: new Date(now.getTime() + BATCH_WINDOW_MS),
        }),
      }),
    )
  })
})

describe("processDueOrchestratorWakeups & processDueOrchestratorHeartbeats", () => {
  it("batches due BATCH_WAIT rows per orchestrator and formats [[thread:<id>|Title]] wakeup prompt", async () => {
    const now = new Date("2026-11-14T18:05:00.000Z")
    const startContinuation = vi.fn().mockResolvedValue({
      status: "started",
      runId: "dispatched-run-1",
      conversationId: ORCH_CONV_ID,
    })
    const mockPrisma = {
      agentOrchestratorWakeup: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([]) // dueQuiet
          .mockResolvedValueOnce([
            {
              id: "wake-a",
              orchestratorId: "orch-1",
              workspaceId: WORKSPACE_ID,
              targetConversationId: TARGET_CONV_ID,
              eventStatus: "DONE",
              targetUpdatedAtIso: "2026-11-14T18:00:00.000Z",
              generation: 1,
              busyRetries: 0,
              state: "BATCH_WAIT",
            },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentOrchestrator: {
        findFirst: vi.fn().mockResolvedValue({
          id: "orch-1",
          workspaceId: WORKSPACE_ID,
          userId: USER_ID,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
          conversationId: ORCH_CONV_ID,
          agentId: null,
          enabled: true,
          wakeOnActivity: true,
        }),
      },
      agentConversation: {
        findFirst: vi.fn().mockResolvedValue({ id: ORCH_CONV_ID, archivedAt: null }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: TARGET_CONV_ID,
            title: "Migration 123 verification",
            updatedAt: new Date("2026-11-14T18:00:00.000Z"),
          },
        ]),
      },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    }

    const res = await processDueOrchestratorWakeups({
      prisma: mockPrisma as never,
      now,
      startContinuation,
    })

    expect(res.batchesDispatched).toBe(1)
    expect(res.wakeupsDispatched).toBe(1)
    expect(startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: ORCH_CONV_ID,
        message: expect.stringContaining(`[[thread:${TARGET_CONV_ID}|Migration 123 verification]]`),
      }),
      expect.anything(),
    )
  })

  it("skips activity-gated heartbeats when zero threads or inbox items changed since lastHeartbeatAt", async () => {
    const now = new Date("2026-11-14T19:00:00.000Z")
    const lastHeartbeatAt = new Date("2026-11-14T17:00:00.000Z")
    const startContinuation = vi.fn().mockResolvedValue({
      status: "started",
      runId: "hb-run-1",
      conversationId: ORCH_CONV_ID,
    })

    const mockPrisma = {
      agentOrchestrator: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "orch-1",
              workspaceId: WORKSPACE_ID,
              userId: USER_ID,
              scopeType: "WORKSPACE",
              scopeKey: "workspace",
              conversationId: ORCH_CONV_ID,
              agentId: null,
              heartbeatMinutes: 60,
              lastHeartbeatAt,
            },
          ])
          .mockResolvedValueOnce([{ conversationId: ORCH_CONV_ID }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentOrchestratorWakeup: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      agentConversation: {
        findFirst: vi.fn().mockResolvedValue(null), // no changed thread
      },
      agentInboxItem: {
        findFirst: vi.fn().mockResolvedValue(null), // no pending inbox item
      },
    }

    const quietRes = await processDueOrchestratorHeartbeats({
      prisma: mockPrisma as never,
      now,
      startContinuation,
    })
    expect(quietRes).toEqual({ heartbeatsFired: 0, heartbeatsSkippedQuiet: 1 })
    expect(startContinuation).not.toHaveBeenCalled()

    // Now simulate changed thread in scope -> fires heartbeat
    mockPrisma.agentOrchestrator.findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "orch-1",
          workspaceId: WORKSPACE_ID,
          userId: USER_ID,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
          conversationId: ORCH_CONV_ID,
          agentId: null,
          heartbeatMinutes: 60,
          lastHeartbeatAt,
        },
      ])
      .mockResolvedValueOnce([{ conversationId: ORCH_CONV_ID }])
    mockPrisma.agentConversation.findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: TARGET_CONV_ID }) // changed thread!
      .mockResolvedValueOnce({ id: ORCH_CONV_ID, archivedAt: null }) // ensureOrchestratorConversation
    ;(mockPrisma as Record<string, unknown>).agentRun = {
      findFirst: vi.fn().mockResolvedValue(null),
    }

    const activeRes = await processDueOrchestratorHeartbeats({
      prisma: mockPrisma as never,
      now,
      startContinuation,
    })
    expect(activeRes).toEqual({ heartbeatsFired: 1, heartbeatsSkippedQuiet: 0 })
    expect(startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: ORCH_CONV_ID,
        message: WORKSPACE_HEARTBEAT_PROMPT,
      }),
      expect.anything(),
    )
  })

  it("formats buildOrchestratorWakeupPrompt cleanly", () => {
    const prompt = buildOrchestratorWakeupPrompt("SQUAD", [
      {
        conversationId: TARGET_CONV_ID,
        title: "API [Auth] | Fix",
        eventStatus: "ERROR",
        targetUpdatedAtIso: "2026-11-14T18:00:00.000Z",
      },
    ])
    expect(prompt).toContain("[Squad Orchestrator Wake-up]")
    expect(prompt).toContain(`[[thread:${TARGET_CONV_ID}|API  Auth    Fix]] — status: ERROR`)
  })
})
