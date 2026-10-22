/**
 * Retention for agent conversation data.
 *
 * Policy (published in the Privacy Policy via AGENT_DATA_RETENTION_DAYS): agent conversation messages and agent
 * run events older than one year are permanently deleted. Run events are where tool results live, including Drive
 * file contents the agent read, and messages are where replies that quote or summarize them live, so those two
 * tables are the policy. Two things that hold copies of the same content ride along:
 *
 *   - Session transcripts (private blob objects that let a conversation resume). A transcript embeds every earlier
 *     turn, so it is deleted whenever messages of its conversation are pruned (the agent then replays recent text
 *     instead, which is its normal fallback), and also when a conversation has been idle for the whole period.
 *   - Conversation shells. Once a stale conversation has no messages left and no recent run, the empty conversation
 *     (its title can paraphrase the first message), its participants and its run summaries are removed too.
 *
 * NOT covered, and not claimed: workspace content the agent wrote (docs, tasks, comments), run summary rows of
 * conversations that are still alive (status, token counts, cost: no conversation or file content), and
 * the web-search audit table.
 *
 * Properties the cron relies on:
 *   - Idempotent and resumable. Every deleted row leaves the matched set, so a run that hits its time budget is
 *     simply continued by the next one.
 *   - Batched. Deletes are by id page (lib/batched-delete.ts), never one unbounded statement, so DSQL's
 *     ~3,000-rows-per-transaction ceiling holds; works unchanged on plain Postgres.
 *   - Safe before the optional indexes (migration 100) exist: queries are correct either way, only slower.
 */
import type { AppPrismaClient } from "@/lib/db"
import { AGENT_DATA_RETENTION_DAYS } from "@/lib/legal-config"
import { DELETE_BATCH_SIZE, deleteInBatches } from "@/lib/batched-delete"
import { RUN_EVENT_BATCH_SIZE, deleteSessionTranscripts, purgeConversations, tolerateMissingTable } from "@/lib/agent-conversation-purge"
import type { ArtifactStorage } from "@/lib/artifact-storage"

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_RETENTION_BUDGET_MS = 240_000

export interface PruneOptions {
  prisma: AppPrismaClient
  now?: Date
  retentionDays?: number
  /** Wall-clock budget; the cron route runs under a 300 s function ceiling. */
  budgetMs?: number
  batchSize?: number
  storage?: () => ArtifactStorage
}

export interface PruneResult {
  cutoff: string
  runEventsDeleted: number
  messagesDeleted: number
  transcriptsDeleted: number
  transcriptsFailed: number
  conversationsDeleted: number
  /** True when the time budget stopped the run early; the next run continues. */
  truncated: boolean
}

export function retentionCutoff(now: Date, retentionDays: number = AGENT_DATA_RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

export async function pruneAgentData(options: PruneOptions): Promise<PruneResult> {
  const { prisma } = options
  const now = options.now ?? new Date()
  const cutoff = retentionCutoff(now, options.retentionDays)
  const batchSize = options.batchSize ?? DELETE_BATCH_SIZE
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_RETENTION_BUDGET_MS)
  const expired = () => Date.now() >= deadline
  const result: PruneResult = {
    cutoff: cutoff.toISOString(),
    runEventsDeleted: 0,
    messagesDeleted: 0,
    transcriptsDeleted: 0,
    transcriptsFailed: 0,
    conversationsDeleted: 0,
    truncated: false,
  }

  // 1. Run events: the Drive-content-bearing trace.
  result.runEventsDeleted = await tolerateMissingTable(
    () => deleteInBatches(prisma.agentRunEvent, { createdAt: { lt: cutoff } }, { batchSize: Math.min(batchSize, RUN_EVENT_BATCH_SIZE), deadline }),
    0,
  )

  // 2. Messages, with their conversations' transcripts removed first (a transcript outlives nothing it embeds).
  const failedConversations = new Set<string>()
  while (!expired()) {
    const rows = await prisma.agentMessage.findMany({
      where: {
        createdAt: { lt: cutoff },
        ...(failedConversations.size ? { conversationId: { notIn: [...failedConversations] } } : {}),
      },
      select: { id: true, conversationId: true },
      take: batchSize,
    })
    if (rows.length === 0) break
    const conversationIds = [...new Set(rows.map((row) => row.conversationId))]
    const transcripts = await deleteSessionTranscripts(prisma, { conversationId: { in: conversationIds } }, options.storage, deadline)
    result.transcriptsDeleted += transcripts.removed
    result.transcriptsFailed += transcripts.failed
    // The transcript step may have stopped at the deadline with objects still present. Never delete the messages they embed
    // in that case; the next run starts from the same rows.
    if (expired()) break
    if (transcripts.failed > 0) {
      // Keep this conversation's messages until its transcript object is really gone; retried next run.
      const stuck = await tolerateMissingTable(
        async () => (await prisma.agentSession.findMany({ where: { conversationId: { in: conversationIds } }, select: { conversationId: true } })).map((row) => row.conversationId),
        [] as string[],
      )
      for (const id of stuck) failedConversations.add(id)
    }
    const deletable = rows.filter((row) => !failedConversations.has(row.conversationId)).map((row) => row.id)
    if (deletable.length) {
      const deleted = await prisma.agentMessage.deleteMany({ where: { id: { in: deletable } } })
      result.messagesDeleted += deleted.count
    }
    if (deletable.length === 0 && failedConversations.size === 0) break
  }

  // 3. Idle transcripts: a conversation nobody has touched for the whole period keeps no resumable copy.
  if (!expired()) {
    const idle = await deleteSessionTranscripts(prisma, { updatedAt: { lt: cutoff } }, options.storage, deadline)
    result.transcriptsDeleted += idle.removed
    result.transcriptsFailed += idle.failed
  }

  // 4. Empty stale conversation shells.
  let cursor: string | undefined
  while (!expired()) {
    const stale = await prisma.agentConversation.findMany({
      where: { updatedAt: { lt: cutoff }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    })
    if (stale.length === 0) break
    cursor = stale[stale.length - 1].id
    const ids = stale.map((row) => row.id)
    const withMessages = new Set((await prisma.agentMessage.findMany({ where: { conversationId: { in: ids } }, select: { conversationId: true } })).map((row) => row.conversationId))
    const withRecentRuns = new Set(
      await tolerateMissingTable(
        async () => (await prisma.agentRun.findMany({ where: { conversationId: { in: ids }, createdAt: { gte: cutoff } }, select: { conversationId: true } })).map((row) => row.conversationId),
        [] as string[],
      ),
    )
    const empty = ids.filter((id) => !withMessages.has(id) && !withRecentRuns.has(id))
    if (empty.length) {
      const { purged } = await purgeConversations(prisma, empty, { storage: options.storage })
      result.conversationsDeleted += purged.length
    }
    if (stale.length < batchSize) break
  }

  result.truncated = expired()
  return result
}
