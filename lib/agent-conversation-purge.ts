/**
 * Hard deletion of agent conversation data, shared by account deletion and the retention job so the
 * two cannot disagree about what "a conversation's data" is.
 *
 * The schema runs with `relationMode = "prisma"` (no foreign keys on either backend), so nothing here
 * cascades: every dependent table is deleted explicitly, children before parents, in bounded batches
 * (see lib/batched-delete.ts for why). Every step tolerates a table that has not been migrated yet
 * (P2021), because a deployment that has not applied 069/080/081/082 must still be able to purge.
 */
import type { AppPrismaClient } from "@/lib/db"
import { getAgentSessionStorage, type ArtifactStorage } from "@/lib/artifact-storage"
import { DELETE_BATCH_SIZE, deleteInBatches, isMissingTable, pages } from "@/lib/batched-delete"

/** Run-event payloads can be large (tool results, Drive file contents), so their pages are smaller than the default. */
export const RUN_EVENT_BATCH_SIZE = 100
/** Blob deletions in flight at once; a page of 500 unbounded requests would hammer the blob API. */
export const BLOB_DELETE_CONCURRENCY = 10

export async function tolerateMissingTable<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isMissingTable(error)) return fallback
    throw error
  }
}

/** Run traces (events, then runs) for a set of runs selected by `where`. Returns runs removed. */
export async function deleteRunsWhere(prisma: AppPrismaClient, where: Record<string, unknown>): Promise<number> {
  return tolerateMissingTable(async () => {
    let removed = 0
    for (;;) {
      const runs = await prisma.agentRun.findMany({ where, select: { id: true }, take: DELETE_BATCH_SIZE })
      if (runs.length === 0) return removed
      const runIds = runs.map((run) => run.id)
      await deleteInBatches(prisma.agentRunEvent, { runId: { in: runIds } }, { batchSize: RUN_EVENT_BATCH_SIZE })
      const result = await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } })
      removed += result.count
      if (runs.length < DELETE_BATCH_SIZE) return removed
    }
  }, 0)
}

/**
 * Web-search audit rows (composite key credentialId + seq, no id column), deleted in bounded pages by key so a user or
 * conversation with a very large history cannot exceed DSQL's per-statement row cap and make deletion unretryable.
 */
export async function deleteWebSearchesWhere(prisma: AppPrismaClient, where: Record<string, unknown>): Promise<number> {
  return tolerateMissingTable(async () => {
    let total = 0
    for (;;) {
      const rows = await prisma.agentWebSearch.findMany({ where, select: { credentialId: true, seq: true }, take: DELETE_BATCH_SIZE })
      if (rows.length === 0) return total
      const deleted = await prisma.agentWebSearch.deleteMany({ where: { OR: rows.map((row) => ({ credentialId: row.credentialId, seq: row.seq })) } })
      total += deleted.count
      if (rows.length < DELETE_BATCH_SIZE) return total
    }
  }, 0)
}

export interface TranscriptRemoval {
  removed: number
  /** Blob objects that could not be deleted; their pointer rows are kept so a later run retries them. */
  failed: number
}

/**
 * Deletes Agent SDK session transcripts (private blob objects that can contain Drive file contents)
 * and then their pointer rows. A pointer row is only removed once its object is gone, so a blob outage
 * leaves a retryable record instead of an unreachable orphan.
 */
export async function deleteSessionTranscripts(
  prisma: AppPrismaClient,
  where: Record<string, unknown>,
  storage?: () => ArtifactStorage,
  /** Epoch ms; stop before starting another page once reached (the retention cron's time budget). */
  deadline?: number,
): Promise<TranscriptRemoval> {
  return tolerateMissingTable(async () => {
    const result: TranscriptRemoval = { removed: 0, failed: 0 }
    const failedConversationIds = new Set<string>()
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) return result
      const rows = await prisma.agentSession.findMany({
        where: failedConversationIds.size ? { AND: [where, { conversationId: { notIn: [...failedConversationIds] } }] } : where,
        select: { conversationId: true, blobKey: true },
        take: DELETE_BATCH_SIZE,
      })
      if (rows.length === 0) return result
      let blobs: ArtifactStorage | null = null
      try {
        blobs = (storage ?? getAgentSessionStorage)()
      } catch {
        // Blob storage is not configured on this deployment, so no transcript object can exist.
      }
      const deletable: string[] = []
      for (const group of pages(rows, BLOB_DELETE_CONCURRENCY)) {
        await Promise.all(
          group.map(async (row) => {
            try {
              if (blobs) await blobs.del(row.blobKey)
              deletable.push(row.conversationId)
            } catch (error) {
              result.failed++
              failedConversationIds.add(row.conversationId)
              console.error("[agent-purge] could not delete a transcript object", error)
            }
          }),
        )
      }
      if (deletable.length) {
        const deleted = await prisma.agentSession.deleteMany({ where: { conversationId: { in: deletable } } })
        result.removed += deleted.count
      }
      // Every row is either gone now or excluded by the notIn filter above, so the next page makes progress.
    }
  }, { removed: 0, failed: 0 })
}

/**
 * Removes the given conversations and everything that hangs off them: run traces, session transcripts,
 * messages, participants, audit rows, web-search rows and the interview/API-key pointers.
 * Conversations whose transcript objects could not be deleted are left in place (returned in `kept`).
 */
export async function purgeConversations(
  prisma: AppPrismaClient,
  conversationIds: readonly string[],
  options: { storage?: () => ArtifactStorage } = {},
): Promise<{ purged: string[]; kept: string[] }> {
  const purged: string[] = []
  const kept: string[] = []
  for (const page of pages(conversationIds, 100)) {
    let ids = page
    const transcripts = await deleteSessionTranscripts(prisma, { conversationId: { in: ids } }, options.storage)
    if (transcripts.failed > 0) {
      const stuck = await tolerateMissingTable(
        async () => (await prisma.agentSession.findMany({ where: { conversationId: { in: ids } }, select: { conversationId: true } })).map((row) => row.conversationId),
        [] as string[],
      )
      const stuckSet = new Set(stuck)
      kept.push(...ids.filter((id) => stuckSet.has(id)))
      ids = ids.filter((id) => !stuckSet.has(id))
      if (ids.length === 0) continue
    }
    await prisma.pMInterview.updateMany({ where: { agentConversationId: { in: ids } }, data: { agentConversationId: null } })
    await deleteInBatches(prisma.apiKey, { scopeConversationId: { in: ids } })
    await deleteRunsWhere(prisma, { conversationId: { in: ids } })
    await deleteInBatches(prisma.agentMessage, { conversationId: { in: ids } })
    await tolerateMissingTable(() => deleteInBatches(prisma.agentConversationParticipant, { conversationId: { in: ids } }), 0)
    await deleteInBatches(prisma.agentAuditLog, { conversationId: { in: ids } })
    await deleteWebSearchesWhere(prisma, { conversationId: { in: ids } })
    await prisma.agentConversation.deleteMany({ where: { id: { in: ids } } })
    purged.push(...ids)
  }
  return { purged, kept }
}
