/**
 * Event Wake-up Pipeline, Two-Stage Debounce State Machine & Activity-Gated Heartbeats
 * (`lib/orchestrator/wakeups.ts`, migration 123).
 *
 * Implements the durable serverless equivalent of `WakeupService.ts` and `HeartbeatService.ts`:
 * - 60s quiet wait (`QUIET_WAIT_MS`) after `SUCCEEDED` turns so rapid back-to-back turns settle.
 * - 0s quiet wait on `FAILED` / `INTERRUPTED` turns so errors surface fast.
 * - 12s batch window (`BATCH_WINDOW_MS`) coalescing multiple settled threads into one orchestrator turn.
 * - `HELD_BUSY` retry (up to `MAX_BUSY_RETRIES = 3`) when the orchestrator conversation is mid-turn,
 *   flushing as soon as the orchestrator's own run settles.
 * - Strict loop prevention: runs belonging to any `AgentOrchestrator` conversation never enqueue wake-ups.
 * - Auto-ensures a Squad Orchestrator on the first completed Squad thread (unless disabled by the user),
 *   while never auto-creating a Workspace Orchestrator on wake-up.
 * - Activity-gated heartbeats (`processDueOrchestratorHeartbeats`): skips firing when zero conversations
 *   or inbox items in scope have changed since `lastHeartbeatAt`.
 */

import { after } from "next/server"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { DELETE_BATCH_SIZE, deleteInBatches, isMissingTable } from "@/lib/batched-delete"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { findActiveAgentRun, NON_TERMINAL_AGENT_RUN_STATUSES } from "@/lib/agent-runs"
import {
  startConversationContinuationRun,
  type ContinuationRunOutcome,
} from "@/lib/agent-continuation-run"

export const QUIET_WAIT_MS = 60_000
export const BATCH_WINDOW_MS = 12_000
export const MAX_BUSY_RETRIES = 3
export const MIN_HEARTBEAT_MINUTES = 5
export const MAX_HEARTBEAT_MINUTES = 1_440
export const DEFAULT_HEARTBEAT_MINUTES = 60
export const ORCHESTRATOR_SWEEP_BATCH_LIMIT = 25

export type OrchestratorWakeupEventStatus = "DONE" | "ERROR"
export type OrchestratorWakeupState =
  | "QUIET_WAIT"
  | "BATCH_WAIT"
  | "HELD_BUSY"
  | "DISPATCHED"
  | "DROPPED"

export const WORKSPACE_HEARTBEAT_PROMPT = `[Workspace Orchestrator Heartbeat]
Run a periodic portfolio review across this workspace using your thread-orchestrator skill:
1. Call threads_get_current and threads_list to inspect unassigned threads and per-Squad rollups (squadSummaries).
2. Skip unchanged threads whose managerNotes already record cursor=<exact thread.updatedAt>.
3. For any thread with new activity, read recent messages (threads_get_messages), update Manager Notes v2 (threads_set_notes) with cursor=<exact thread.updatedAt>, and apply the 5-part Intervention Gate before staging a ProposedReply (threads_set_proposed_reply) or Decision (threads_post_decision).
4. Reference threads in prose using [[thread:<id>|Title]] links. If nothing requires attention, finish in one concise sentence.`

export const SQUAD_HEARTBEAT_PROMPT = `[Squad Orchestrator Heartbeat]
Run a periodic review of threads in your Squad using your thread-orchestrator skill:
1. Call threads_get_current and threads_list to inspect threads in your Squad.
2. Skip unchanged threads whose managerNotes already record cursor=<exact thread.updatedAt>.
3. For any thread with new activity, read recent messages (threads_get_messages), update Manager Notes v2 (threads_set_notes) with cursor=<exact thread.updatedAt>, and apply the 5-part Intervention Gate before staging a ProposedReply (threads_set_proposed_reply) or Decision (threads_post_decision).
4. If a thread is blocked on a cross-Squad dependency, has an unresolved error you cannot unblock, or has had a needs_you item waiting > 15 minutes, escalate a concise update via notify_workspace_orchestrator.
5. Reference threads in prose using [[thread:<id>|Title]] links. If nothing requires attention, finish in one concise sentence.`

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  const code = (error as { code?: unknown })?.code
  return code === "P2022" || code === "42703"
}

export function clampHeartbeatMinutes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HEARTBEAT_MINUTES
  return Math.max(MIN_HEARTBEAT_MINUTES, Math.min(MAX_HEARTBEAT_MINUTES, Math.round(value)))
}

export interface WakeupPromptItem {
  conversationId: string
  title: string
  eventStatus: OrchestratorWakeupEventStatus
  targetUpdatedAtIso: string
}

export function buildOrchestratorWakeupPrompt(
  scopeType: "WORKSPACE" | "SQUAD",
  items: readonly WakeupPromptItem[],
): string {
  const scopeLabel = scopeType === "SQUAD" ? "Squad" : "Workspace"
  const lines = items.map((item) => {
    const cleanTitle = (item.title || "Untitled conversation").replace(/[\[\]|]/g, " ").trim()
    const tag = item.eventStatus === "ERROR" ? "ERROR" : "DONE"
    return `- [[thread:${item.conversationId}|${cleanTitle}]] — status: ${tag}, updatedAt: ${item.targetUpdatedAtIso}`
  })
  return `[${scopeLabel} Orchestrator Wake-up]
The following thread${items.length === 1 ? "" : "s"} in your coordination scope just settled:
${lines.join("\n")}

Review ${items.length === 1 ? "this thread" : "these threads"} using your thread-orchestrator skill:
1. Call threads_get_messages (and threads_get_log if status is ERROR) on each settled thread whose managerNotes cursor is older than updatedAt.
2. Update Manager Notes v2 via threads_set_notes with cursor=<exact updatedAt>.
3. Apply the 5-part Intervention Gate: only call threads_set_proposed_reply or threads_post_decision if human input or a routine follow-up will materially advance the thread's goal. Never auto-send a message during a background review.`
}

/**
 * Ensures an `AgentOrchestrator` has a backing `AgentConversation` and returns its `conversationId`.
 */
export async function ensureOrchestratorConversation(
  prisma: AppPrismaClient,
  orchestrator: {
    id: string
    workspaceId: string
    userId: string
    scopeType: string
    scopeKey: string
    conversationId: string | null
  },
  titleHint?: string,
  now = new Date(),
): Promise<string> {
  if (orchestrator.conversationId) {
    const existing = await prisma.agentConversation.findFirst({
      where: {
        id: orchestrator.conversationId,
        workspaceId: orchestrator.workspaceId,
        userId: orchestrator.userId,
      },
      select: { id: true, archivedAt: true },
    })
    if (existing) {
      if (existing.archivedAt !== null) {
        await prisma.agentConversation.updateMany({
          where: { id: existing.id, workspaceId: orchestrator.workspaceId },
          data: { archivedAt: null, updatedAt: now },
        })
      }
      return existing.id
    }
  }

  let title = titleHint
  const squadId = orchestrator.scopeType === "SQUAD" ? orchestrator.scopeKey : null
  if (!title) {
    if (squadId) {
      const squad = await prisma.squad.findFirst({
        where: { id: squadId, workspaceId: orchestrator.workspaceId },
        select: { name: true },
      })
      title = `${squad?.name ?? "Squad"} Orchestrator`
    } else {
      title = "Workspace Orchestrator"
    }
  }

  let createdId: string
  try {
    const created = await prisma.agentConversation.create({
      data: {
        workspaceId: orchestrator.workspaceId,
        userId: orchestrator.userId,
        title,
        squadId,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })
    createdId = created.id
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
    const fallback = await prisma.agentConversation.create({
      data: {
        workspaceId: orchestrator.workspaceId,
        userId: orchestrator.userId,
        title,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })
    createdId = fallback.id
  }

  await prisma.agentOrchestrator.updateMany({
    where: { id: orchestrator.id, workspaceId: orchestrator.workspaceId },
    data: { conversationId: createdId, updatedAt: now },
  })

  return createdId
}

/**
 * Promotes `HELD_BUSY` wakeups when an orchestrator's own run finishes so queued notifications flush immediately.
 */
export async function onOrchestratorRunSettled(params: {
  prisma?: AppPrismaClient
  orchestratorId: string
  workspaceId: string
  now?: Date
}): Promise<number> {
  const prisma = params.prisma ?? getPrisma()
  const now = params.now ?? new Date()
  if (!prisma.agentOrchestratorWakeup) return 0

  try {
    const held = await prisma.agentOrchestratorWakeup.findMany({
      where: {
        orchestratorId: params.orchestratorId,
        workspaceId: params.workspaceId,
        state: "HELD_BUSY",
      },
      select: { id: true },
    })
    if (held.length === 0) return 0

    const promoted = await prisma.agentOrchestratorWakeup.updateMany({
      where: {
        id: { in: held.map((r) => r.id) },
        state: "HELD_BUSY",
      },
      data: {
        state: "BATCH_WAIT",
        flushAfter: now,
        updatedAt: now,
      },
    })
    return promoted.count
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}

function scheduleInlineWakeupSweep(delayMs: number) {
  try {
    after(async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(delayMs, 50), 75_000)))
      try {
        await processDueOrchestratorWakeups()
      } catch (err) {
        console.warn("[orchestrator-wakeups] inline after() sweep failed", err)
      }
    })
  } catch {
    // Outside a Next.js request context (e.g. unit tests); cron handles it.
  }
}

/**
 * Hook called from `finalizeAgentRun` (`lib/agent-runs.ts`).
 * - Skips runs belonging to any `AgentOrchestrator` conversation (no self/loop wake-ups), while releasing
 *   any `HELD_BUSY` batch waiting on that orchestrator.
 * - Never auto-creates a Workspace Orchestrator on wake-up.
 * - Auto-ensures a Squad Orchestrator on the first completed Squad run (unless the user disabled it).
 */
export async function enqueueOrchestratorWakeupOnRunFinalize(params: {
  prisma?: AppPrismaClient
  runId: string
  workspaceId: string
  conversationId: string
  userId: string
  status: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED"
  errorCode?: string | null
  now?: Date
  disableInlineAfter?: boolean
}): Promise<
  | { enqueued: true; wakeupId: string; orchestratorId: string; state: OrchestratorWakeupState }
  | {
      enqueued: false
      reason:
        | "orchestrator_self_run"
        | "ignored_status"
        | "conversation_missing_or_archived"
        | "orchestrator_disabled_or_missing"
        | "schema_unapplied"
    }
> {
  const prisma = params.prisma ?? getPrisma()
  const now = params.now ?? new Date()
  if (!prisma.agentOrchestrator || !prisma.agentOrchestratorWakeup) {
    return { enqueued: false, reason: "schema_unapplied" }
  }

  try {
    // 1. Check if this run belongs to an orchestrator conversation itself (loop prevention).
    const selfOrch = await prisma.agentOrchestrator.findFirst({
      where: {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
      },
      select: { id: true, workspaceId: true },
    })
    if (selfOrch) {
      const promoted = await onOrchestratorRunSettled({
        prisma,
        orchestratorId: selfOrch.id,
        workspaceId: selfOrch.workspaceId,
        now,
      })
      if (promoted > 0 && !params.disableInlineAfter) {
        scheduleInlineWakeupSweep(100)
      }
      return { enqueued: false, reason: "orchestrator_self_run" }
    }

    // 2. Ignore CANCELED runs and runs parked on AskUserQuestion (AWAITING_USER).
    if (
      params.status === "CANCELED" ||
      (params.status === "INTERRUPTED" && params.errorCode === "AWAITING_USER")
    ) {
      return { enqueued: false, reason: "ignored_status" }
    }

    // 3. Load target conversation metadata.
    const conv = await prisma.agentConversation.findFirst({
      where: {
        id: params.conversationId,
        workspaceId: params.workspaceId,
        userId: params.userId,
      },
      select: {
        id: true,
        squadId: true,
        archivedAt: true,
        updatedAt: true,
      },
    })
    if (!conv || conv.archivedAt !== null) {
      return { enqueued: false, reason: "conversation_missing_or_archived" }
    }

    // 4. Resolve or auto-ensure the appropriate personal orchestrator for `(userId, workspaceId, squadId)`.
    let orchestrator: {
      id: string
      enabled: boolean
      wakeOnActivity: boolean
    } | null = null

    if (conv.squadId) {
      const existingSquadOrch = await prisma.agentOrchestrator.findFirst({
        where: {
          userId: params.userId,
          workspaceId: params.workspaceId,
          scopeType: "SQUAD",
          scopeKey: conv.squadId,
        },
        select: {
          id: true,
          enabled: true,
          wakeOnActivity: true,
          conversationId: true,
        },
      })

      if (existingSquadOrch) {
        orchestrator = existingSquadOrch
      } else {
        // Auto-ensure Squad Orchestrator on first completed Squad run.
        const squad = await prisma.squad.findFirst({
          where: { id: conv.squadId, workspaceId: params.workspaceId },
          select: { id: true, name: true },
        })
        if (squad) {
          const backingConv = await prisma.agentConversation.create({
            data: {
              workspaceId: params.workspaceId,
              userId: params.userId,
              title: `${squad.name} Orchestrator`,
              squadId: squad.id,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          })
          const createdOrch = await prisma.agentOrchestrator.create({
            data: {
              workspaceId: params.workspaceId,
              userId: params.userId,
              scopeType: "SQUAD",
              scopeKey: squad.id,
              conversationId: backingConv.id,
              enabled: true,
              wakeOnActivity: true,
              heartbeatEnabled: false,
              heartbeatMinutes: DEFAULT_HEARTBEAT_MINUTES,
              escalationsEnabled: true,
              createdAt: now,
              updatedAt: now,
            },
            select: {
              id: true,
              enabled: true,
              wakeOnActivity: true,
            },
          })
          orchestrator = createdOrch
        }
      }
    } else {
      // Unassigned conversation -> Workspace Orchestrator (never auto-created on wakeup).
      orchestrator = await prisma.agentOrchestrator.findFirst({
        where: {
          userId: params.userId,
          workspaceId: params.workspaceId,
          scopeType: "WORKSPACE",
          scopeKey: "workspace",
        },
        select: {
          id: true,
          enabled: true,
          wakeOnActivity: true,
        },
      })
    }

    if (!orchestrator || !orchestrator.enabled || !orchestrator.wakeOnActivity) {
      return { enqueued: false, reason: "orchestrator_disabled_or_missing" }
    }

    const eventStatus: OrchestratorWakeupEventStatus =
      params.status === "SUCCEEDED" ? "DONE" : "ERROR"
    const isError = eventStatus === "ERROR"
    const quietUntil = isError ? now : new Date(now.getTime() + QUIET_WAIT_MS)
    const flushAfter = isError ? new Date(now.getTime() + BATCH_WINDOW_MS) : null
    const nextState: OrchestratorWakeupState = isError ? "BATCH_WAIT" : "QUIET_WAIT"
    const targetUpdatedAtIso = conv.updatedAt.toISOString()

    const existingWakeup = await prisma.agentOrchestratorWakeup.findFirst({
      where: {
        orchestratorId: orchestrator.id,
        targetConversationId: conv.id,
      },
      select: { id: true, generation: true },
    })

    let wakeupId: string
    if (existingWakeup) {
      await prisma.agentOrchestratorWakeup.update({
        where: { id: existingWakeup.id },
        data: {
          eventStatus,
          targetUpdatedAtIso,
          quietUntil,
          flushAfter,
          generation: existingWakeup.generation + 1,
          busyRetries: 0,
          state: nextState,
          dispatchedRunId: null,
          updatedAt: now,
        },
      })
      wakeupId = existingWakeup.id
    } else {
      const created = await prisma.agentOrchestratorWakeup.create({
        data: {
          orchestratorId: orchestrator.id,
          workspaceId: params.workspaceId,
          targetConversationId: conv.id,
          eventStatus,
          targetUpdatedAtIso,
          quietUntil,
          flushAfter,
          generation: 1,
          busyRetries: 0,
          state: nextState,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      wakeupId = created.id
    }

    if (!params.disableInlineAfter) {
      scheduleInlineWakeupSweep(isError ? BATCH_WINDOW_MS + 250 : QUIET_WAIT_MS + 250)
    }

    return {
      enqueued: true,
      wakeupId,
      orchestratorId: orchestrator.id,
      state: nextState,
    }
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      return { enqueued: false, reason: "schema_unapplied" }
    }
    throw error
  }
}

export interface OrchestratorSweepSummary {
  quietPromoted: number
  quietExtended: number
  batchesDispatched: number
  wakeupsDispatched: number
  heldBusy: number
  dropped: number
  heartbeatsFired: number
  heartbeatsSkippedQuiet: number
}

/**
 * Advances due `QUIET_WAIT` rows into `BATCH_WAIT` and flushes due `BATCH_WAIT` / `HELD_BUSY`
 * batches per orchestrator.
 */
export async function processDueOrchestratorWakeups(params: {
  prisma?: AppPrismaClient
  now?: Date
  limit?: number
  startContinuation?: typeof startConversationContinuationRun
} = {}): Promise<
  Pick<
    OrchestratorSweepSummary,
    | "quietPromoted"
    | "quietExtended"
    | "batchesDispatched"
    | "wakeupsDispatched"
    | "heldBusy"
    | "dropped"
  >
> {
  const prisma = params.prisma ?? getPrisma()
  const now = params.now ?? new Date()
  const limit = params.limit ?? ORCHESTRATOR_SWEEP_BATCH_LIMIT
  const startContinuation = params.startContinuation ?? startConversationContinuationRun

  const summary = {
    quietPromoted: 0,
    quietExtended: 0,
    batchesDispatched: 0,
    wakeupsDispatched: 0,
    heldBusy: 0,
    dropped: 0,
  }

  if (!prisma.agentOrchestrator || !prisma.agentOrchestratorWakeup) {
    return summary
  }

  try {
    // Stage 1: Promote due QUIET_WAIT rows to BATCH_WAIT (or extend if target had newer activity).
    const dueQuiet = await prisma.agentOrchestratorWakeup.findMany({
      where: {
        state: "QUIET_WAIT",
        quietUntil: { lte: now },
      },
      orderBy: { quietUntil: "asc" },
      take: limit,
      select: {
        id: true,
        workspaceId: true,
        targetConversationId: true,
        targetUpdatedAtIso: true,
        generation: true,
      },
    })

    for (const row of dueQuiet) {
      const [conv, activeTargetRun] = await Promise.all([
        prisma.agentConversation.findFirst({
          where: { id: row.targetConversationId, workspaceId: row.workspaceId },
          select: { id: true, archivedAt: true, updatedAt: true },
        }),
        findActiveAgentRun({ prisma, conversationId: row.targetConversationId }),
      ])

      if (!conv || conv.archivedAt !== null) {
        const dropped = await prisma.agentOrchestratorWakeup.updateMany({
          where: { id: row.id, state: "QUIET_WAIT", generation: row.generation },
          data: { state: "DROPPED", updatedAt: now },
        })
        summary.dropped += dropped.count
        continue
      }

      const currentIso = conv.updatedAt.toISOString()
      if (activeTargetRun || currentIso > row.targetUpdatedAtIso) {
        const extended = await prisma.agentOrchestratorWakeup.updateMany({
          where: { id: row.id, state: "QUIET_WAIT", generation: row.generation },
          data: {
            targetUpdatedAtIso: currentIso,
            quietUntil: new Date(now.getTime() + QUIET_WAIT_MS),
            updatedAt: now,
          },
        })
        summary.quietExtended += extended.count
        continue
      }

      const promoted = await prisma.agentOrchestratorWakeup.updateMany({
        where: { id: row.id, state: "QUIET_WAIT", generation: row.generation },
        data: {
          state: "BATCH_WAIT",
          flushAfter: new Date(now.getTime() + BATCH_WINDOW_MS),
          updatedAt: now,
        },
      })
      summary.quietPromoted += promoted.count
    }

    // Stage 2: Flush due BATCH_WAIT rows (and HELD_BUSY rows whose orchestrator may now be free).
    const dueBatchRows = await prisma.agentOrchestratorWakeup.findMany({
      where: {
        OR: [
          { state: "BATCH_WAIT", flushAfter: { lte: now } },
          { state: "HELD_BUSY" },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: limit * 2,
      select: {
        id: true,
        orchestratorId: true,
        workspaceId: true,
        targetConversationId: true,
        eventStatus: true,
        targetUpdatedAtIso: true,
        generation: true,
        busyRetries: true,
        state: true,
      },
    })

    const byOrchestrator = new Map<string, typeof dueBatchRows>()
    for (const row of dueBatchRows) {
      const list = byOrchestrator.get(row.orchestratorId) ?? []
      list.push(row)
      byOrchestrator.set(row.orchestratorId, list)
    }

    for (const [orchestratorId, batch] of byOrchestrator.entries()) {
      const orch = await prisma.agentOrchestrator.findFirst({
        where: { id: orchestratorId },
        select: {
          id: true,
          workspaceId: true,
          userId: true,
          scopeType: true,
          scopeKey: true,
          conversationId: true,
          agentId: true,
          enabled: true,
          wakeOnActivity: true,
        },
      })

      if (!orch || !orch.enabled || !orch.wakeOnActivity) {
        const dropped = await prisma.agentOrchestratorWakeup.updateMany({
          where: { id: { in: batch.map((b) => b.id) } },
          data: { state: "DROPPED", updatedAt: now },
        })
        summary.dropped += dropped.count
        continue
      }

      const orchConversationId = await ensureOrchestratorConversation(prisma, orch, undefined, now)
      const activeOrchRun = await findActiveAgentRun({ prisma, conversationId: orchConversationId })

      if (activeOrchRun) {
        for (const item of batch) {
          // Only increment busyRetries when transitioning from BATCH_WAIT -> HELD_BUSY,
          // so cron sweeps while the same run is still active don't prematurely exhaust retries.
          if (item.state === "HELD_BUSY") {
            continue
          }
          const nextRetries = item.busyRetries + 1
          if (nextRetries >= MAX_BUSY_RETRIES) {
            const dropped = await prisma.agentOrchestratorWakeup.updateMany({
              where: { id: item.id, generation: item.generation },
              data: {
                state: "DROPPED",
                busyRetries: nextRetries,
                updatedAt: now,
              },
            })
            summary.dropped += dropped.count
          } else {
            const held = await prisma.agentOrchestratorWakeup.updateMany({
              where: { id: item.id, generation: item.generation },
              data: {
                state: "HELD_BUSY",
                busyRetries: nextRetries,
                updatedAt: now,
              },
            })
            summary.heldBusy += held.count
          }
        }
        continue
      }

      // Load target titles and filter out any target that became active again or was archived.
      const targetConvs = await prisma.agentConversation.findMany({
        where: {
          id: { in: batch.map((b) => b.targetConversationId) },
          workspaceId: orch.workspaceId,
          archivedAt: null,
        },
        select: {
          id: true,
          title: true,
          updatedAt: true,
        },
      })
      const convById = new Map(targetConvs.map((c) => [c.id, c]))

      const readyRows: typeof batch = []
      for (const item of batch) {
        const target = convById.get(item.targetConversationId)
        if (!target) {
          const dropped = await prisma.agentOrchestratorWakeup.updateMany({
            where: { id: item.id, generation: item.generation },
            data: { state: "DROPPED", updatedAt: now },
          })
          summary.dropped += dropped.count
          continue
        }
        readyRows.push(item)
      }

      if (readyRows.length === 0) continue

      const claimedIds: string[] = []
      for (const item of readyRows) {
        const claimed = await prisma.agentOrchestratorWakeup.updateMany({
          where: {
            id: item.id,
            generation: item.generation,
            state: { in: ["BATCH_WAIT", "HELD_BUSY"] },
          },
          data: {
            state: "DISPATCHED",
            updatedAt: now,
          },
        })
        if (claimed.count === 1) {
          claimedIds.push(item.id)
        }
      }

      if (claimedIds.length === 0) continue

      const claimedItems: WakeupPromptItem[] = readyRows
        .filter((r) => claimedIds.includes(r.id))
        .map((r) => {
          const conv = convById.get(r.targetConversationId)
          return {
            conversationId: r.targetConversationId,
            title: conv?.title ?? "Untitled conversation",
            eventStatus: r.eventStatus === "ERROR" ? "ERROR" : "DONE",
            targetUpdatedAtIso: conv?.updatedAt.toISOString() ?? r.targetUpdatedAtIso,
          }
        })

      const scopeType = orch.scopeType === "SQUAD" ? "SQUAD" : "WORKSPACE"
      const prompt = buildOrchestratorWakeupPrompt(scopeType, claimedItems)

      const outcome: ContinuationRunOutcome = await startContinuation(
        {
          workspaceId: orch.workspaceId,
          conversationId: orchConversationId,
          userId: orch.userId,
          preferredAgentId: orch.agentId,
          message: prompt,
        },
        { prisma, now: () => now },
      )

      if (outcome.status === "started") {
        await prisma.agentOrchestratorWakeup.updateMany({
          where: { id: { in: claimedIds } },
          data: { dispatchedRunId: outcome.runId, updatedAt: now },
        })
        summary.batchesDispatched += 1
        summary.wakeupsDispatched += claimedIds.length
      } else {
        await prisma.agentOrchestratorWakeup.updateMany({
          where: { id: { in: claimedIds } },
          data: { state: "DROPPED", updatedAt: now },
        })
        summary.dropped += claimedIds.length
      }
    }

    return summary
  } catch (error) {
    if (isMissingSchemaObject(error)) return summary
    throw error
  }
}

/**
 * Evaluates activity-gated heartbeats for enabled orchestrators with `heartbeatEnabled: true`.
 * Skips firing when zero threads in scope have been updated since `lastHeartbeatAt` and no
 * unresolved inbox items exist in scope.
 */
export async function processDueOrchestratorHeartbeats(params: {
  prisma?: AppPrismaClient
  now?: Date
  limit?: number
  startContinuation?: typeof startConversationContinuationRun
} = {}): Promise<Pick<OrchestratorSweepSummary, "heartbeatsFired" | "heartbeatsSkippedQuiet">> {
  const prisma = params.prisma ?? getPrisma()
  const now = params.now ?? new Date()
  const limit = params.limit ?? ORCHESTRATOR_SWEEP_BATCH_LIMIT
  const startContinuation = params.startContinuation ?? startConversationContinuationRun

  const summary = {
    heartbeatsFired: 0,
    heartbeatsSkippedQuiet: 0,
  }

  if (!prisma.agentOrchestrator) return summary

  try {
    const candidates = await prisma.agentOrchestrator.findMany({
      where: {
        enabled: true,
        heartbeatEnabled: true,
      },
      orderBy: { updatedAt: "asc" },
      take: limit * 2,
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        scopeType: true,
        scopeKey: true,
        conversationId: true,
        agentId: true,
        heartbeatMinutes: true,
        lastHeartbeatAt: true,
      },
    })

    for (const orch of candidates) {
      const intervalMs = clampHeartbeatMinutes(orch.heartbeatMinutes) * 60_000
      if (orch.lastHeartbeatAt && now.getTime() - orch.lastHeartbeatAt.getTime() < intervalMs) {
        continue
      }

      // Skip if there are pending wakeup rows for this orchestrator (wakeup batch takes precedence).
      if (prisma.agentOrchestratorWakeup) {
        const pendingWakeup = await prisma.agentOrchestratorWakeup.findFirst({
          where: {
            orchestratorId: orch.id,
            state: { in: ["QUIET_WAIT", "BATCH_WAIT", "HELD_BUSY"] },
          },
          select: { id: true },
        })
        if (pendingWakeup) continue
      }

      // Activity Gate: check if at least 1 non-orchestrator thread in scope updated since lastHeartbeatAt
      // or if an unresolved AgentInboxItem exists in scope.
      const allOrchConvs = await prisma.agentOrchestrator.findMany({
        where: { workspaceId: orch.workspaceId, userId: orch.userId },
        select: { conversationId: true },
      })
      const excludedIds = allOrchConvs
        .map((o) => o.conversationId)
        .filter((id): id is string => Boolean(id))

      const scopeFilter =
        orch.scopeType === "SQUAD" ? { squadId: orch.scopeKey } : {}

      const changedThread = await prisma.agentConversation.findFirst({
        where: {
          ...accessibleConversationsWhere(orch.workspaceId, orch.userId),
          ...scopeFilter,
          archivedAt: null,
          ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
          ...(orch.lastHeartbeatAt ? { updatedAt: { gt: orch.lastHeartbeatAt } } : {}),
        },
        select: { id: true },
      })

      let hasPendingInbox = false
      if (!changedThread && prisma.agentInboxItem) {
        try {
          const openItem = await prisma.agentInboxItem.findFirst({
            where: {
              workspaceId: orch.workspaceId,
              recipientUserId: orch.userId,
              status: "PENDING",
            },
            select: { id: true },
          })
          hasPendingInbox = Boolean(openItem)
        } catch (err) {
          if (!isMissingSchemaObject(err)) throw err
        }
      }

      if (!changedThread && !hasPendingInbox) {
        summary.heartbeatsSkippedQuiet += 1
        continue
      }

      const orchConversationId = await ensureOrchestratorConversation(prisma, orch, undefined, now)
      const activeRun = await findActiveAgentRun({ prisma, conversationId: orchConversationId })
      if (activeRun) continue

      const claimed = await prisma.agentOrchestrator.updateMany({
        where: {
          id: orch.id,
          ...(orch.lastHeartbeatAt ? { lastHeartbeatAt: orch.lastHeartbeatAt } : { lastHeartbeatAt: null }),
        },
        data: {
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      })
      if (claimed.count !== 1) continue

      const prompt =
        orch.scopeType === "SQUAD" ? SQUAD_HEARTBEAT_PROMPT : WORKSPACE_HEARTBEAT_PROMPT
      const outcome = await startContinuation(
        {
          workspaceId: orch.workspaceId,
          conversationId: orchConversationId,
          userId: orch.userId,
          preferredAgentId: orch.agentId,
          message: prompt,
        },
        { prisma, now: () => now },
      )

      if (outcome.status === "started") {
        summary.heartbeatsFired += 1
      }
    }

    return summary
  } catch (error) {
    if (isMissingSchemaObject(error)) return summary
    throw error
  }
}

/**
 * Combined cron entry point for `/api/cron/agent-orchestrator`.
 */
export async function sweepOrchestratorWakeupsAndHeartbeats(params: {
  prisma?: AppPrismaClient
  now?: Date
  limit?: number
  startContinuation?: typeof startConversationContinuationRun
} = {}): Promise<OrchestratorSweepSummary> {
  const wakeups = await processDueOrchestratorWakeups(params)
  const heartbeats = await processDueOrchestratorHeartbeats(params)
  return {
    ...wakeups,
    ...heartbeats,
  }
}

export interface PersonalOrchestratorSettingsData {
  workspaceOrchestrator: {
    id: string | null
    enabled: boolean
    wakeOnActivity: boolean
    heartbeatEnabled: boolean
    heartbeatMinutes: number
    conversationId: string | null
    agentId: string | null
  }
  squadOrchestrators: Array<{
    squadId: string
    squadName: string
    squadColor: string
    id: string | null
    enabled: boolean
    wakeOnActivity: boolean
    heartbeatEnabled: boolean
    heartbeatMinutes: number
    escalationsEnabled: boolean
    conversationId: string | null
    agentId: string | null
  }>
}

/**
 * Loads the signed-in user's personal Workspace & Squad Orchestrator settings for the Settings page.
 * Gracefully falls back to defaults if migration 122 is unapplied.
 */
export async function loadPersonalOrchestratorSettings(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string,
  squads: ReadonlyArray<{ id: string; name: string; color: string }>,
): Promise<PersonalOrchestratorSettingsData> {
  const defaultResult: PersonalOrchestratorSettingsData = {
    workspaceOrchestrator: {
      id: null,
      enabled: false,
      wakeOnActivity: true,
      heartbeatEnabled: false,
      heartbeatMinutes: DEFAULT_HEARTBEAT_MINUTES,
      conversationId: null,
      agentId: null,
    },
    squadOrchestrators: squads.map((s) => ({
      squadId: s.id,
      squadName: s.name,
      squadColor: s.color,
      id: null,
      enabled: false,
      wakeOnActivity: true,
      heartbeatEnabled: false,
      heartbeatMinutes: DEFAULT_HEARTBEAT_MINUTES,
      escalationsEnabled: true,
      conversationId: null,
      agentId: null,
    })),
  }

  if (!prisma.agentOrchestrator) return defaultResult

  try {
    const rows = await prisma.agentOrchestrator.findMany({
      where: { workspaceId, userId },
      select: {
        id: true,
        scopeType: true,
        scopeKey: true,
        conversationId: true,
        agentId: true,
        enabled: true,
        wakeOnActivity: true,
        heartbeatEnabled: true,
        heartbeatMinutes: true,
        escalationsEnabled: true,
      },
    })

    const wsRow = rows.find((r) => r.scopeType === "WORKSPACE" && r.scopeKey === "workspace")
    const bySquad = new Map(
      rows.filter((r) => r.scopeType === "SQUAD").map((r) => [r.scopeKey, r]),
    )

    return {
      workspaceOrchestrator: wsRow
        ? {
            id: wsRow.id,
            enabled: wsRow.enabled,
            wakeOnActivity: wsRow.wakeOnActivity,
            heartbeatEnabled: wsRow.heartbeatEnabled,
            heartbeatMinutes: clampHeartbeatMinutes(wsRow.heartbeatMinutes),
            conversationId: wsRow.conversationId,
            agentId: wsRow.agentId,
          }
        : defaultResult.workspaceOrchestrator,
      squadOrchestrators: squads.map((s) => {
        const sq = bySquad.get(s.id)
        return {
          squadId: s.id,
          squadName: s.name,
          squadColor: s.color,
          id: sq?.id ?? null,
          enabled: sq?.enabled ?? false,
          wakeOnActivity: sq?.wakeOnActivity ?? true,
          heartbeatEnabled: sq?.heartbeatEnabled ?? false,
          heartbeatMinutes: clampHeartbeatMinutes(sq?.heartbeatMinutes),
          escalationsEnabled: sq?.escalationsEnabled ?? true,
          conversationId: sq?.conversationId ?? null,
          agentId: sq?.agentId ?? null,
        }
      }),
    }
  } catch (error) {
    if (isMissingSchemaObject(error)) return defaultResult
    throw error
  }
}

/** Batched workspace teardown helper for `AgentOrchestratorWakeup` (`P2021`-tolerant). */
export async function deleteWorkspaceAgentOrchestratorWakeups(
  prisma: Partial<Pick<AppPrismaClient, "agentOrchestratorWakeup">>,
  workspaceId: string,
): Promise<number> {
  if (!prisma.agentOrchestratorWakeup) return 0
  try {
    return await deleteInBatches(
      prisma.agentOrchestratorWakeup,
      { workspaceId },
      { batchSize: DELETE_BATCH_SIZE },
    )
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}
