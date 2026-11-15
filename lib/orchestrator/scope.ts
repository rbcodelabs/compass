/**
 * Multi-User & Squad Coordination Scope (`lib/orchestrator/scope.ts`, migration 122).
 *
 * Enforces:
 * 1. Live `AGENT_TURN` run resolution (same boundary as `ScheduleWakeup`).
 * 2. Strict per-user + per-workspace isolation via `accessibleConversationsWhere(workspaceId, userId)`
 *    so a thread or orchestrator running on behalf of User A can never discover, read, message, or
 *    supervise User B's private conversations in the same workspace.
 * 3. Squad coordination boundaries:
 *    - Squad threads (`squadId !== null`) coordinate only with threads in the same Squad.
 *    - Unassigned threads (`squadId === null`, non-orchestrator) coordinate only with unassigned
 *      threads, with an explicit self-assignment carve-out allowing an unassigned thread to assign
 *      *itself* to a Squad via `threads_set_squad`.
 *    - Workspace Orchestrator (`scopeType === "WORKSPACE"`) sees unassigned threads + Squad summaries
 *      by default, and uses explicit `elevatedSquadId` per call for cross-Squad reads/proposals
 *      without taking ownership of Squad manager notes (`operation === "notes"` is denied under elevation).
 * 4. Self-target & self-approval guards:
 *    - Never allow targeting the caller's own thread on `threads_send_message`, `threads_set_proposed_reply`,
 *      or `threads_archive` (unless `confirm: true` on an orchestrator).
 *    - Never allow an orchestrator to bypass human approval of a pending `ProposedReply` via `threads_send_message`.
 */

import type { AppPrismaClient } from "@/lib/db"
import { DELETE_BATCH_SIZE, deleteInBatches, isMissingTable } from "@/lib/batched-delete"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { getMcpActor } from "@/lib/mcp-authz"

export const OUTSIDE_COORDINATION_SCOPE_MESSAGE = "Target is outside coordination scope."
export const DESTINATION_OUTSIDE_SCOPE_MESSAGE = "Destination Squad is outside coordination scope."

export type OrchestratorScopeType = "WORKSPACE" | "SQUAD"
export type ThreadCoordinationOperation = "read" | "write" | "notes"

export interface CallerOrchestratorInfo {
  id: string
  scopeType: OrchestratorScopeType
  scopeKey: string
  enabled: boolean
}

export interface CallingThreadContext {
  runId: string
  conversationId: string
  workspaceId: string
  userId: string
  agentId: string | null
  squadId: string | null
  orchestrator: CallerOrchestratorInfo | null
}

export interface TargetConversationSummary {
  id: string
  workspaceId: string
  userId: string
  title: string | null
  squadId: string | null
  archivedAt: Date | null
  summary: string | null
  prUrl: string | null
  updatedAt: Date
}

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  const code = (error as { code?: unknown })?.code
  return code === "P2022" || code === "42703"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim())
}

/**
 * Pure coordination scope evaluator for `read`, `write`, and `notes` operations.
 */
export function evaluateThreadCoordinationAccess(params: {
  caller: Pick<CallingThreadContext, "conversationId" | "squadId" | "orchestrator">
  target: { id: string; squadId: string | null }
  elevatedSquadId?: string | null
  operation: ThreadCoordinationOperation
}): boolean {
  const { caller, target, operation } = params
  const elevated = params.elevatedSquadId?.trim() || undefined

  if (caller.orchestrator?.scopeType === "WORKSPACE") {
    if (elevated) {
      // Workspace orchestrator elevation grants read/write into the specified Squad,
      // but NEVER overwrites Squad manager notes.
      if (operation === "notes") return false
      return target.squadId === elevated
    }
    return target.squadId === null || target.id === caller.conversationId
  }

  // Non-Workspace-Orchestrator callers may never use elevatedSquadId.
  if (elevated) return false

  if (caller.orchestrator?.scopeType === "SQUAD") {
    const squadKey = caller.orchestrator.scopeKey
    return target.squadId === squadKey || target.id === caller.conversationId
  }

  if (caller.squadId !== null) {
    return target.squadId === caller.squadId
  }

  return target.squadId === null
}

/**
 * Pure evaluator for Squad assignment/creation destinations (`threads_set_squad`, `threads_create`).
 * Includes the self-assignment carve-out allowing an unassigned thread to assign *itself* to a Squad.
 */
export function evaluateSquadDestinationAccess(params: {
  caller: Pick<CallingThreadContext, "conversationId" | "squadId" | "orchestrator">
  destinationSquadId: string | null | undefined
  elevatedSquadId?: string | null
  targetConversationId?: string
}): boolean {
  const { caller, targetConversationId } = params
  const dest = params.destinationSquadId ?? null
  const elevated = params.elevatedSquadId?.trim() || undefined

  if (caller.orchestrator?.scopeType === "WORKSPACE") {
    if (dest === null) {
      return !elevated
    }
    return elevated === dest
  }

  if (elevated) return false

  if (caller.orchestrator?.scopeType === "SQUAD") {
    const squadKey = caller.orchestrator.scopeKey
    return dest === null || dest === squadKey
  }

  if (caller.squadId !== null) {
    return dest === null || dest === caller.squadId
  }

  // Unassigned non-orchestrator thread:
  if (dest === null) return true
  // Self-assignment carve-out: an unassigned thread may assign itself to a Squad,
  // but may not move any other thread into a Squad.
  return Boolean(targetConversationId && targetConversationId === caller.conversationId)
}

/**
 * Enforces self-send prohibition and blocks an orchestrator from self-approving a pending
 * `ProposedReply` via `threads_send_message`.
 */
export function evaluateSendMessageGuard(params: {
  caller: Pick<CallingThreadContext, "conversationId" | "orchestrator">
  targetConversationId: string
  pendingProposedReply?: {
    text: string | null
    authorOrchestratorId?: string | null
  } | null
}): { allowed: true } | { allowed: false; reason: string } {
  const { caller, targetConversationId, pendingProposedReply } = params
  if (targetConversationId === caller.conversationId) {
    return { allowed: false, reason: "Cannot send a message to the current thread." }
  }
  if (pendingProposedReply?.text && pendingProposedReply.text.trim().length > 0) {
    if (caller.orchestrator !== null) {
      return {
        allowed: false,
        reason:
          "Cannot send a message to a thread while a proposed reply is awaiting human approval. Wait for the user to approve or clear the proposed reply first.",
      }
    }
  }
  return { allowed: true }
}

/**
 * Resolves the live `AGENT_TURN` run and its conversation + orchestrator role.
 */
export async function resolveCallingThreadContext(
  prisma: Pick<AppPrismaClient, "agentRun" | "agentConversation"> &
    Partial<Pick<AppPrismaClient, "agentOrchestrator">>,
): Promise<CallingThreadContext> {
  const actor = getMcpActor()
  if (actor.purpose !== "AGENT_TURN" || !actor.credentialId) {
    throw new Error(
      "Thread coordination tools can only be called by an in-app agent during an active turn.",
    )
  }

  let activeRun: {
    id: string
    conversationId: string
    workspaceId: string
    userId: string
    agentId: string | null
  } | null = null

  try {
    const found = await prisma.agentRun.findFirst({
      where: {
        apiKeyId: actor.credentialId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        conversationId: true,
        workspaceId: true,
        userId: true,
        agentId: true,
      },
    })
    activeRun = found ? { ...found, agentId: found.agentId ?? null } : null
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
    const fallback = await prisma.agentRun.findFirst({
      where: {
        apiKeyId: actor.credentialId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        conversationId: true,
        workspaceId: true,
        userId: true,
      },
    })
    activeRun = fallback ? { ...fallback, agentId: null } : null
  }

  if (!activeRun) {
    throw new Error("No active running agent turn found for this conversation.")
  }

  let squadId: string | null = null
  try {
    const conv = await prisma.agentConversation.findFirst({
      where: {
        id: activeRun.conversationId,
        ...accessibleConversationsWhere(activeRun.workspaceId, activeRun.userId),
      },
      select: { id: true, squadId: true },
    })
    if (!conv) {
      throw new Error("Current conversation is not accessible in this workspace.")
    }
    squadId = conv.squadId ?? null
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
    const conv = await prisma.agentConversation.findFirst({
      where: {
        id: activeRun.conversationId,
        ...accessibleConversationsWhere(activeRun.workspaceId, activeRun.userId),
      },
      select: { id: true },
    })
    if (!conv) {
      throw new Error("Current conversation is not accessible in this workspace.")
    }
  }

  let orchestrator: CallerOrchestratorInfo | null = null
  if (prisma.agentOrchestrator) {
    try {
      const orch = await prisma.agentOrchestrator.findFirst({
        where: {
          workspaceId: activeRun.workspaceId,
          userId: activeRun.userId,
          conversationId: activeRun.conversationId,
        },
        select: {
          id: true,
          scopeType: true,
          scopeKey: true,
          enabled: true,
        },
      })
      if (orch) {
        const scopeType: OrchestratorScopeType =
          orch.scopeType === "SQUAD" ? "SQUAD" : "WORKSPACE"
        orchestrator = {
          id: orch.id,
          scopeType,
          scopeKey: orch.scopeKey,
          enabled: orch.enabled,
        }
        if (scopeType === "SQUAD" && !squadId) {
          squadId = orch.scopeKey
        }
      }
    } catch (error) {
      if (!isMissingSchemaObject(error)) throw error
    }
  }

  return {
    runId: activeRun.id,
    conversationId: activeRun.conversationId,
    workspaceId: activeRun.workspaceId,
    userId: activeRun.userId,
    agentId: activeRun.agentId ?? null,
    squadId,
    orchestrator,
  }
}

/**
 * Loads a target conversation within `(caller.workspaceId, caller.userId)` and verifies
 * `evaluateThreadCoordinationAccess`. Throws `OUTSIDE_COORDINATION_SCOPE_MESSAGE` on any
 * missing, inaccessible, or out-of-scope target so existence is never leaked across users or Squads.
 */
export async function requireAuthorizedTargetConversation(
  prisma: Pick<AppPrismaClient, "agentConversation">,
  caller: CallingThreadContext,
  targetConversationId: string,
  elevatedSquadId: string | undefined,
  operation: ThreadCoordinationOperation,
): Promise<TargetConversationSummary> {
  if (!isValidUuid(targetConversationId)) {
    throw new Error(OUTSIDE_COORDINATION_SCOPE_MESSAGE)
  }

  let target: TargetConversationSummary | null = null
  try {
    target = await prisma.agentConversation.findFirst({
      where: {
        id: targetConversationId,
        ...accessibleConversationsWhere(caller.workspaceId, caller.userId),
      },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        title: true,
        squadId: true,
        archivedAt: true,
        summary: true,
        prUrl: true,
        updatedAt: true,
      },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
    const fallback = await prisma.agentConversation.findFirst({
      where: {
        id: targetConversationId,
        ...accessibleConversationsWhere(caller.workspaceId, caller.userId),
      },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        title: true,
        archivedAt: true,
        updatedAt: true,
      },
    })
    if (fallback) {
      target = {
        ...fallback,
        squadId: null,
        summary: null,
        prUrl: null,
      }
    }
  }

  if (!target) {
    throw new Error(OUTSIDE_COORDINATION_SCOPE_MESSAGE)
  }

  const allowed = evaluateThreadCoordinationAccess({
    caller,
    target: { id: target.id, squadId: target.squadId },
    elevatedSquadId,
    operation,
  })
  if (!allowed) {
    throw new Error(OUTSIDE_COORDINATION_SCOPE_MESSAGE)
  }

  return target
}

/** Batched workspace teardown helper for `AgentOrchestrator` (`P2021`-tolerant). */
export async function deleteWorkspaceAgentOrchestrators(
  prisma: Partial<Pick<AppPrismaClient, "agentOrchestrator">>,
  workspaceId: string,
): Promise<number> {
  if (!prisma.agentOrchestrator) return 0
  try {
    return await deleteInBatches(prisma.agentOrchestrator, { workspaceId }, { batchSize: DELETE_BATCH_SIZE })
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}

/** Batched workspace teardown helper for `AgentConversationSupervision` (`P2021`-tolerant). */
export async function deleteWorkspaceConversationSupervision(
  prisma: Partial<Pick<AppPrismaClient, "agentConversationSupervision">>,
  workspaceId: string,
): Promise<number> {
  if (!prisma.agentConversationSupervision) return 0
  try {
    return await deleteInBatches(
      prisma.agentConversationSupervision,
      { workspaceId },
      { batchSize: DELETE_BATCH_SIZE },
    )
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}
