/**
 * The legacy writers of task_links that feed the entity_links mirror (ADR "One generic entity_links table", phase 7). The legacy table is
 * the source of truth: each function writes it first, then mirrors the same link into entity_links INSIDE THE SAME TRANSACTION
 * (lib/links/legacy-mirror.ts, behind COMPASS_ENTITY_LINKS_TASK_MIRROR), so the two commit or roll back together and neither drifts.
 * Removal never depends on the flag. Reads and the generic link tools ignore the type until a later phase flips reads.
 *
 * Rows of linked_type COMMENT (a Doc comment a task was made from) are legacy-only and never mirrored.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { runTypedLinkTransaction } from "@/lib/typed-links"

// lib/links/* imports lib/typed-links, which this module also uses: load the mirror lazily, like lib/typed-links.ts does.
const legacyMirror = () => import("@/lib/links/legacy-mirror")

export type TaskLinkRecord = { id: string; taskId: string; linkedType: string; linkedId: string; source?: string | null; createdById?: string | null }

/** Mirrors links that were just created in `tx` (for example nested in a task create). */
export async function mirrorTaskLinks(tx: AppTransactionClient, input: { workspaceId: string; links: readonly Omit<TaskLinkRecord, "id">[] }): Promise<void> {
  const mirror = await legacyMirror()
  for (const link of input.links) await mirror.mirrorTaskReference(tx, { link, workspaceId: input.workspaceId })
}

/** Creates the legacy row (the caller already checked for an existing one and validated the target) and mirrors it. */
export async function createTaskLink(
  prisma: AppPrismaClient,
  input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string },
): Promise<TaskLinkRecord> {
  return runTypedLinkTransaction(prisma, async (tx) => {
    const link = (await tx.taskLink.create({ data: { taskId: input.taskId, linkedType: input.linkedType, linkedId: input.linkedId } })) as TaskLinkRecord
    await mirrorTaskLinks(tx, { workspaceId: input.workspaceId, links: [{ taskId: input.taskId, linkedType: input.linkedType, linkedId: input.linkedId, source: link.source, createdById: link.createdById }] })
    return link
  })
}

/** Idempotent create-or-keep of the legacy row, mirrored. `upsert` is the caller's own upsert so its exact arguments stay unchanged. */
export async function upsertTaskLink(
  prisma: AppPrismaClient,
  input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string; upsert: (tx: AppTransactionClient) => Promise<TaskLinkRecord> },
): Promise<TaskLinkRecord> {
  return runTypedLinkTransaction(prisma, async (tx) => {
    const link = await input.upsert(tx)
    await mirrorTaskLinks(tx, { workspaceId: input.workspaceId, links: [{ taskId: input.taskId, linkedType: input.linkedType, linkedId: input.linkedId, source: link.source, createdById: link.createdById }] })
    return link
  })
}

/** Deletes the legacy row by id and removes its mirror row, whatever the flag says. */
export async function deleteTaskLink(
  prisma: AppPrismaClient,
  input: { link: Pick<TaskLinkRecord, "id" | "taskId" | "linkedType" | "linkedId">; workspaceId: string },
): Promise<void> {
  await runTypedLinkTransaction(prisma, async (tx) => {
    await tx.taskLink.delete({ where: { id: input.link.id } })
    await (await legacyMirror()).unmirrorTaskReference(tx, { link: input.link, workspaceId: input.workspaceId })
  })
}

/**
 * The mirror of a legacy delete that removed every task link to deleted targets (deleteObjective, deleteKeyResult). Run it AFTER the delete
 * commits, in committed passes (drainAfterParentDelete): a failure leaves stale mirror rows that migration 097 prunes.
 */
export async function drainMirroredTaskLinksTo(db: AppTransactionClient, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  return (await legacyMirror()).drainMirroredTaskReferencesTo(db, input)
}
