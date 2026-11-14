/**
 * Durable `ScheduleWakeup` lifecycle (migration 121):
 *   - `scheduleAgentWakeup`: MCP tool handler scoped to the calling `AGENT_TURN` run. Clamps delays
 *     to `[60, 3600]` seconds (1m–1h, matching Geode / Claude Code self-pacing), replaces any prior
 *     `PENDING` wake-up on the same conversation, schedules a best-effort `after()` timer for short
 *     waits (`<= 240s`), and relies on `/api/cron/agent-wakeups` (`* * * * *`) as the durable backstop.
 *   - `fireDueAgentWakeups` / `fireScheduledWakeupById`: atomically claims `PENDING -> FIRED` once no
 *     active run is in flight on the conversation, then dispatches `startConversationContinuationRun`.
 *   - `cancelConversationWakeup` / `cancelAllPendingConversationWakeups`: cancels pending wake-ups from
 *     the Board/Chat UI or when a human manually sends a chat turn.
 *
 * Every read and write tolerates `121_agent_interactive_controls` being unapplied (`P2021` / `P2022`).
 */

import { after } from "next/server"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { DELETE_BATCH_SIZE, deleteInBatches, isMissingTable } from "@/lib/batched-delete"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { findActiveAgentRun } from "@/lib/agent-runs"
import {
  startConversationContinuationRun,
  type ContinuationDeps,
  type ContinuationRunOutcome,
} from "@/lib/agent-continuation-run"

export const MIN_WAKEUP_DELAY_SECONDS = 60
export const MAX_WAKEUP_DELAY_SECONDS = 3_600
export const INLINE_AFTER_MAX_DELAY_SECONDS = 240
export const WAKEUP_SWEEP_BATCH_LIMIT = 25

export type SerializedScheduledWakeup = {
  id: string
  conversationId: string
  fireAt: string
  delaySeconds: number
  reason: string | null
  prompt: string
  status: "PENDING" | "FIRED" | "CANCELED" | "FAILED"
  createdAt: string
}

export class AgentWakeupError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "AgentWakeupError"
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

export function clampWakeupDelaySeconds(delaySeconds: number): number {
  if (!Number.isFinite(delaySeconds)) return MIN_WAKEUP_DELAY_SECONDS
  return Math.min(MAX_WAKEUP_DELAY_SECONDS, Math.max(MIN_WAKEUP_DELAY_SECONDS, Math.round(delaySeconds)))
}

function serializeWakeupRow(row: {
  id: string
  conversationId: string
  fireAt: Date
  delaySeconds: number
  reason: string | null
  prompt: string
  status: string
  createdAt: Date
}): SerializedScheduledWakeup {
  const status =
    row.status === "FIRED" || row.status === "CANCELED" || row.status === "FAILED"
      ? row.status
      : "PENDING"
  return {
    id: row.id,
    conversationId: row.conversationId,
    fireAt: row.fireAt.toISOString(),
    delaySeconds: row.delaySeconds,
    reason: row.reason,
    prompt: row.prompt,
    status,
    createdAt: row.createdAt.toISOString(),
  }
}

const WAKEUP_ROW_SELECT = {
  id: true,
  workspaceId: true,
  conversationId: true,
  userId: true,
  agentId: true,
  sourceRunId: true,
  fireAt: true,
  delaySeconds: true,
  reason: true,
  prompt: true,
  status: true,
  createdAt: true,
} as const

type ActiveTurnRun = {
  id: string
  conversationId: string
  workspaceId: string
  userId: string
  agentId: string | null
}

async function resolveCallingAgentRun(prisma: AppPrismaClient): Promise<ActiveTurnRun | null> {
  const actor = getMcpActor()
  if (actor.purpose !== "AGENT_TURN" || !actor.credentialId) return null
  try {
    const run = await prisma.agentRun.findFirst({
      where: { apiKeyId: actor.credentialId, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true, conversationId: true, workspaceId: true, userId: true, agentId: true },
    })
    return run ?? null
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
    const fallback = await prisma.agentRun.findFirst({
      where: { apiKeyId: actor.credentialId, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true, conversationId: true, workspaceId: true, userId: true },
    })
    return fallback ? { ...fallback, agentId: null } : null
  }
}

export type ScheduleWakeupInput = {
  delaySeconds?: number
  reason?: string
  prompt?: string
  stop?: boolean
}

export type ScheduleWakeupOptions = {
  prisma?: AppPrismaClient
  now?: Date
  resolveTurnRun?: () => Promise<ActiveTurnRun | null>
  scheduleInlineTimer?: (delayMs: number, task: () => Promise<void>) => void
}

function defaultInlineTimer(delayMs: number, task: () => Promise<void>) {
  try {
    after(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      await task().catch((error) => {
        console.warn("[agent-wakeups] inline after() wakeup failed; cron sweeper will retry if still pending", error)
      })
    })
  } catch {
    // Outside a Next.js request scope; `/api/cron/agent-wakeups` handles due rows.
  }
}

/** MCP tool handler for `ScheduleWakeup`. */
export async function scheduleAgentWakeup(
  input: ScheduleWakeupInput,
  options: ScheduleWakeupOptions = {},
) {
  const prisma = options.prisma ?? getPrisma()
  const now = options.now ?? new Date()
  const turnRun = await (options.resolveTurnRun ? options.resolveTurnRun() : resolveCallingAgentRun(prisma))
  if (!turnRun) {
    return fail("ScheduleWakeup is only available inside a live agent conversation turn.")
  }

  try {
    const canceled = await prisma.agentScheduledWakeup.updateMany({
      where: { conversationId: turnRun.conversationId, status: "PENDING" },
      data: { status: "CANCELED", canceledAt: now, updatedAt: now },
    })

    if (input.stop) {
      await prisma.agentConversation
        .update({ where: { id: turnRun.conversationId }, data: { updatedAt: now }, select: { id: true } })
        .catch(() => {})
      return ok(
        canceled.count > 0
          ? "Canceled pending scheduled wake-up for this conversation."
          : "No pending scheduled wake-up was active for this conversation.",
        { stopped: true, canceledCount: canceled.count },
      )
    }

    const promptText = input.prompt?.trim() ?? ""
    if (!promptText) {
      return fail("A non-empty `prompt` is required when scheduling a wake-up (unless `stop: true` is set).")
    }

    const rawDelay = typeof input.delaySeconds === "number" ? input.delaySeconds : MIN_WAKEUP_DELAY_SECONDS
    const clampedDelaySeconds = clampWakeupDelaySeconds(rawDelay)
    const fireAt = new Date(now.getTime() + clampedDelaySeconds * 1_000)
    const reason = input.reason?.trim() ? clip(input.reason, 300) : null

    const created = await prisma.agentScheduledWakeup.create({
      data: {
        workspaceId: turnRun.workspaceId,
        conversationId: turnRun.conversationId,
        userId: turnRun.userId,
        agentId: turnRun.agentId,
        sourceRunId: turnRun.id,
        fireAt,
        delaySeconds: clampedDelaySeconds,
        reason,
        prompt: clip(promptText, 4_000),
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      },
      select: WAKEUP_ROW_SELECT,
    })

    await prisma.agentConversation
      .update({ where: { id: turnRun.conversationId }, data: { updatedAt: now }, select: { id: true } })
      .catch(() => {})

    if (clampedDelaySeconds <= INLINE_AFTER_MAX_DELAY_SECONDS) {
      const timer = options.scheduleInlineTimer ?? defaultInlineTimer
      timer(clampedDelaySeconds * 1_000, async () => {
        await fireScheduledWakeupById(prisma, created.id)
      })
    }

    const clampedNotice =
      Math.round(rawDelay) !== clampedDelaySeconds
        ? ` (clamped from ${rawDelay}s to [${MIN_WAKEUP_DELAY_SECONDS}s, ${MAX_WAKEUP_DELAY_SECONDS}s])`
        : ""
    return ok(
      `Scheduled wake-up in ${clampedDelaySeconds}s${clampedNotice} at ${fireAt.toISOString()}` +
        (reason ? ` — ${reason}` : "") +
        `. Wrap up your current response now; Compass will automatically resume this conversation when the timer fires.`,
      serializeWakeupRow(created),
    )
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      return fail("ScheduleWakeup requires migration 121_agent_interactive_controls.")
    }
    throw error
  }
}

function formatWakeupTurnMessage(reason: string | null, prompt: string): string {
  const header = reason ? `[Scheduled wake-up — ${reason}]` : "[Scheduled wake-up]"
  return `${header}\n${prompt}`
}

export type FireWakeupItemResult =
  | { status: "fired"; wakeupId: string; conversationId: string; runId: string }
  | { status: "deferred_busy"; wakeupId: string; conversationId: string }
  | { status: "skipped"; wakeupId: string }
  | { status: "failed"; wakeupId: string; conversationId: string; reason: string }

/**
 * Attempts to fire a single `PENDING` `AgentScheduledWakeup` whose `fireAt <= now`.
 * If the conversation still has a live `QUEUED` / `RUNNING` run (for example, the scheduling turn is
 * still uploading its session), leaves the row `PENDING` so `finalizeAgentRun` or the next cron tick picks it up.
 */
export async function fireScheduledWakeupById(
  prisma: AppPrismaClient,
  wakeupId: string,
  options: { now?: Date; continuationDeps?: Partial<ContinuationDeps> } = {},
): Promise<FireWakeupItemResult> {
  const now = options.now ?? new Date()
  if (!prisma.agentScheduledWakeup) return { status: "skipped", wakeupId }

  let row: {
    id: string
    workspaceId: string
    conversationId: string
    userId: string
    agentId: string | null
    fireAt: Date
    reason: string | null
    prompt: string
    status: string
  } | null = null
  try {
    row = await prisma.agentScheduledWakeup.findUnique({
      where: { id: wakeupId },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        userId: true,
        agentId: true,
        fireAt: true,
        reason: true,
        prompt: true,
        status: true,
      },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) return { status: "skipped", wakeupId }
    throw error
  }

  if (!row || row.status !== "PENDING" || row.fireAt.getTime() > now.getTime()) {
    return { status: "skipped", wakeupId }
  }

  const active = await findActiveAgentRun({ prisma, conversationId: row.conversationId })
  if (active) {
    return { status: "deferred_busy", wakeupId: row.id, conversationId: row.conversationId }
  }

  // Atomically claim PENDING -> FIRED before starting the continuation run so concurrent cron + after() never double-fire.
  const claimed = await prisma.agentScheduledWakeup.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "FIRED", firedAt: now, updatedAt: now },
  })
  if (claimed.count !== 1) {
    return { status: "skipped", wakeupId: row.id }
  }

  let outcome: ContinuationRunOutcome
  try {
    outcome = await startConversationContinuationRun(
      {
        conversationId: row.conversationId,
        workspaceId: row.workspaceId,
        userId: row.userId,
        message: formatWakeupTurnMessage(row.reason, row.prompt),
        preferredAgentId: row.agentId,
        deferLaunch: false,
      },
      { now: () => now, ...options.continuationDeps },
    )
  } catch (error) {
    const reason = clip(error instanceof Error ? error.message : String(error), 500)
    await prisma.agentScheduledWakeup
      .update({
        where: { id: row.id },
        data: { status: "FAILED", failureReason: reason, updatedAt: now },
        select: { id: true },
      })
      .catch(() => {})
    return { status: "failed", wakeupId: row.id, conversationId: row.conversationId, reason }
  }

  if (outcome.status === "already_running") {
    // Another run won the race between findActiveAgentRun and createAgentRun; restore PENDING for after finalize.
    await prisma.agentScheduledWakeup
      .update({
        where: { id: row.id },
        data: { status: "PENDING", firedAt: null, updatedAt: now },
        select: { id: true },
      })
      .catch(() => {})
    return { status: "deferred_busy", wakeupId: row.id, conversationId: row.conversationId }
  }

  if (outcome.status === "refused") {
    const reason = clip(`${outcome.code}: ${outcome.message}`, 500)
    await prisma.agentScheduledWakeup
      .update({
        where: { id: row.id },
        data: { status: "FAILED", failureReason: reason, updatedAt: now },
        select: { id: true },
      })
      .catch(() => {})
    await prisma.agentConversation
      .update({ where: { id: row.conversationId }, data: { updatedAt: now }, select: { id: true } })
      .catch(() => {})
    return { status: "failed", wakeupId: row.id, conversationId: row.conversationId, reason }
  }

  await prisma.agentScheduledWakeup
    .update({
      where: { id: row.id },
      data: { firedRunId: outcome.runId, updatedAt: now },
      select: { id: true },
    })
    .catch(() => {})

  return { status: "fired", wakeupId: row.id, conversationId: row.conversationId, runId: outcome.runId }
}

/** Cron sweeper entry point: fires up to `limit` due `PENDING` wake-ups across workspaces. */
export async function fireDueAgentWakeups({
  prisma,
  now = new Date(),
  limit = WAKEUP_SWEEP_BATCH_LIMIT,
  continuationDeps,
}: {
  prisma: AppPrismaClient
  now?: Date
  limit?: number
  continuationDeps?: Partial<ContinuationDeps>
}) {
  if (!prisma.agentScheduledWakeup) {
    return { scanned: 0, fired: 0, deferredBusy: 0, failed: 0 }
  }

  let dueRows: { id: string }[] = []
  try {
    dueRows = await prisma.agentScheduledWakeup.findMany({
      where: { status: "PENDING", fireAt: { lte: now } },
      orderBy: [{ fireAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      return { scanned: 0, fired: 0, deferredBusy: 0, failed: 0 }
    }
    throw error
  }

  let fired = 0
  let deferredBusy = 0
  let failed = 0
  for (const due of dueRows) {
    const res = await fireScheduledWakeupById(prisma, due.id, { now, continuationDeps })
    if (res.status === "fired") fired += 1
    else if (res.status === "deferred_busy") deferredBusy += 1
    else if (res.status === "failed") failed += 1
  }

  return { scanned: dueRows.length, fired, deferredBusy, failed }
}

/** Invoked when a run finishes cleanly so any wake-up that already matured during turn teardown fires immediately. */
export async function fireDueConversationWakeups(
  prisma: AppPrismaClient,
  conversationId: string,
  options: { now?: Date; continuationDeps?: Partial<ContinuationDeps> } = {},
): Promise<void> {
  if (!prisma.agentScheduledWakeup) return
  const now = options.now ?? new Date()
  try {
    const due = await prisma.agentScheduledWakeup.findMany({
      where: { conversationId, status: "PENDING", fireAt: { lte: now } },
      orderBy: [{ fireAt: "asc" }, { id: "asc" }],
      take: 2,
      select: { id: true },
    })
    for (const row of due) {
      await fireScheduledWakeupById(prisma, row.id, { now, continuationDeps: options.continuationDeps })
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}

/** Session-authorized lookup of the active `PENDING` wake-up for a conversation. */
export async function getConversationPendingWakeup(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string },
): Promise<SerializedScheduledWakeup | null> {
  const access = await resolveConversationAccess(prisma, input)
  if (!access) throw new AgentWakeupError("Conversation not found", 404, "CONVERSATION_NOT_FOUND")
  if (!prisma.agentScheduledWakeup) return null
  try {
    const row = await prisma.agentScheduledWakeup.findFirst({
      where: {
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        status: "PENDING",
      },
      orderBy: [{ fireAt: "asc" }, { createdAt: "desc" }],
      select: WAKEUP_ROW_SELECT,
    })
    return row ? serializeWakeupRow(row) : null
  } catch (error) {
    if (isMissingSchemaObject(error)) return null
    throw error
  }
}

/** Session-authorized cancellation of any `PENDING` wake-up on a conversation (1-click Cancel on Board / Chat). */
export async function cancelConversationWakeup(
  prisma: AppPrismaClient,
  input: { conversationId: string; workspaceId: string; userId: string; wakeupId?: string; now?: Date },
): Promise<{ canceledCount: number }> {
  const access = await resolveConversationAccess(prisma, {
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  })
  if (!access) throw new AgentWakeupError("Conversation not found", 404, "CONVERSATION_NOT_FOUND")
  if (!prisma.agentScheduledWakeup) return { canceledCount: 0 }
  const now = input.now ?? new Date()
  try {
    const res = await prisma.agentScheduledWakeup.updateMany({
      where: {
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        status: "PENDING",
        ...(input.wakeupId ? { id: input.wakeupId } : {}),
      },
      data: { status: "CANCELED", canceledAt: now, updatedAt: now },
    })
    if (res.count > 0) {
      await prisma.agentConversation
        .update({ where: { id: input.conversationId }, data: { updatedAt: now }, select: { id: true } })
        .catch(() => {})
    }
    return { canceledCount: res.count }
  } catch (error) {
    if (isMissingSchemaObject(error)) return { canceledCount: 0 }
    throw error
  }
}

/** Cancels any `PENDING` wake-ups when a human manually sends a new chat turn. */
export async function cancelAllPendingConversationWakeups(
  prisma: Partial<Pick<AppPrismaClient, "agentScheduledWakeup">>,
  input: { conversationId: string; now?: Date },
): Promise<void> {
  if (!prisma.agentScheduledWakeup) return
  const now = input.now ?? new Date()
  try {
    await prisma.agentScheduledWakeup.updateMany({
      where: { conversationId: input.conversationId, status: "PENDING" },
      data: { status: "CANCELED", canceledAt: now, updatedAt: now },
    })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}

/** Batch board loader (`P2021`-tolerant) returning the earliest `PENDING` wake-up per conversation. */
export async function loadScheduledWakeupsByConversation(
  prisma: Partial<Pick<AppPrismaClient, "agentScheduledWakeup">>,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<Map<string, SerializedScheduledWakeup>> {
  const result = new Map<string, SerializedScheduledWakeup>()
  if (!prisma.agentScheduledWakeup || conversationIds.length === 0) return result
  try {
    const rows = await prisma.agentScheduledWakeup.findMany({
      where: {
        workspaceId,
        conversationId: { in: [...conversationIds] },
        status: "PENDING",
      },
      orderBy: [{ fireAt: "asc" }, { createdAt: "desc" }],
      select: WAKEUP_ROW_SELECT,
    })
    for (const row of rows) {
      if (!result.has(row.conversationId)) {
        result.set(row.conversationId, serializeWakeupRow(row))
      }
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
  return result
}

/** Batched workspace teardown helper (`P2021`-tolerant). */
export async function deleteWorkspaceAgentScheduledWakeups(
  prisma: Partial<Pick<AppPrismaClient, "agentScheduledWakeup">>,
  workspaceId: string,
): Promise<number> {
  if (!prisma.agentScheduledWakeup) return 0
  try {
    return await deleteInBatches(prisma.agentScheduledWakeup, { workspaceId }, { batchSize: DELETE_BATCH_SIZE })
  } catch (error) {
    if (isMissingSchemaObject(error)) return 0
    throw error
  }
}
