/**
 * The frozen legacy link tables: `artifact_links` and `task_links`.
 *
 * `artifact_links`. entity_links is the only store for Artifact links (lib/artifacts.ts); nothing reads or writes
 * this table any more. It still exists, with rows from before the cleanup, and Prisma's emulated referential integrity
 * (relationMode = "prisma") makes those rows Restrict the delete of their Artifact. So the two Artifact delete paths remove them here,
 * and this module is the ONLY place that names the model. It is deleted together with the table.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"

type ArtifactLinkDeleter = { artifactLink: Pick<AppPrismaClient["artifactLink"], "deleteMany"> }

/** Removes the frozen artifact_links rows of one Artifact so the Artifact itself can be deleted. */
export async function deleteFrozenArtifactLinks(db: ArtifactLinkDeleter, input: { artifactId: string }): Promise<void> {
  await db.artifactLink.deleteMany({ where: { artifactId: input.artifactId } })
}

/** Removes every frozen artifact_links row stamped with the workspace, ahead of the workspace's Artifacts. */
export async function deleteFrozenWorkspaceArtifactLinks(db: ArtifactLinkDeleter, input: { workspaceId: string }): Promise<void> {
  await db.artifactLink.deleteMany({ where: { workspaceId: input.workspaceId } })
}

// ── task_links ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// entity_links is the only store of task links (TASK_REFERENCES for the nine associations, TASK_CREATED_FROM for COMMENT and
// AGENT_CONVERSATION). task_links is frozen: nothing outside this module and the migrations names it. Two things remain, both deleted
// together with the table:
//
//  1. DEPLOY-BEFORE-MIGRATION FALLBACK. Migration 115 copies the COMMENT and AGENT_CONVERSATION rows into entity_links, and it is run by
//     hand AFTER the code that no longer writes task_links is live. Until its receipt exists, those two kinds are still only in task_links
//     for every link made before the deploy, so the readers merge `readUnmovedTaskLinks` with entity_links (entity_links wins per pair)
//     and a delete removes the pair from both stores (`deleteLegacyTaskLinkPair`), or the fallback would bring the link back. After the
//     migration the fallback finds only rows whose twin already exists, which the merge drops. Reads of the nine associations need no
//     fallback: migration 097 moved them long ago.
//  2. THE EMULATED RESTRICT. TaskLink.task is Restrict under relationMode "prisma", so a workspace teardown deletes the frozen rows
//     before the tasks (`deleteFrozenTaskLinks`).

type TaskLinkDb = AppPrismaClient | AppTransactionClient

/** The task link kinds migration 115 moves; the only kinds the fallback serves. */
export const MOVED_TASK_LINK_TYPES = ["COMMENT", "AGENT_CONVERSATION"] as const

export type UnmovedTaskLink = { id: string; taskId: string; linkedType: string; linkedId: string; source: string; createdById: string | null; createdAt: Date }

/**
 * The COMMENT and AGENT_CONVERSATION rows of task_links, oldest first. Scope by `taskIds`, and/or by `linkedType` + `linkedIds`; `workspaceId`
 * keeps only tasks of that workspace (a legacy row has no workspace of its own).
 */
export async function readUnmovedTaskLinks(
  db: TaskLinkDb,
  input: { taskIds?: readonly string[]; linkedType?: string; linkedIds?: readonly string[]; workspaceId?: string },
): Promise<UnmovedTaskLink[]> {
  if ((input.taskIds && input.taskIds.length === 0) || (input.linkedIds && input.linkedIds.length === 0)) return []
  const wanted = input.linkedType ? [input.linkedType].filter((type) => (MOVED_TASK_LINK_TYPES as readonly string[]).includes(type)) : [...MOVED_TASK_LINK_TYPES]
  if (wanted.length === 0) return []
  return db.taskLink.findMany({
    where: {
      linkedType: { in: wanted },
      ...(input.taskIds ? { taskId: { in: [...input.taskIds] } } : {}),
      ...(input.linkedIds ? { linkedId: { in: [...input.linkedIds] } } : {}),
      ...(input.workspaceId ? { task: { workspaceId: input.workspaceId } } : {}),
    },
    select: { id: true, taskId: true, linkedType: true, linkedId: true, source: true, createdById: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
}

/** The task_links row with this id, whatever its kind (an open page may still hold the id of a link made before the move). */
export async function findLegacyTaskLinkById(db: TaskLinkDb, id: string): Promise<{ id: string; taskId: string; linkedType: string; linkedId: string } | null> {
  return db.taskLink.findUnique({ where: { id }, select: { id: true, taskId: true, linkedType: true, linkedId: true } })
}

/** Removes the frozen row(s) of one pair, so a link removed from entity_links cannot come back through the fallback. */
export async function deleteLegacyTaskLinkPair(db: TaskLinkDb, input: { taskId: string; linkedType: string; linkedId: string }): Promise<void> {
  await db.taskLink.deleteMany({ where: { taskId: input.taskId, linkedType: input.linkedType, linkedId: input.linkedId } })
}

/** Removes the frozen rows that point at deleted targets (a deleted comment). Returns how many went. */
export async function deleteLegacyTaskLinksTo(db: TaskLinkDb, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  if (input.linkedIds.length === 0) return 0
  return (await db.taskLink.deleteMany({ where: { linkedType: input.linkedType, linkedId: { in: [...input.linkedIds] } } })).count
}

/** Removes every frozen row of the given tasks, ahead of the tasks themselves (workspace teardown). The caller chunks the ids. */
export async function deleteFrozenTaskLinks(db: TaskLinkDb, input: { taskIds: readonly string[] }): Promise<void> {
  if (input.taskIds.length === 0) return
  await db.taskLink.deleteMany({ where: { taskId: { in: [...input.taskIds] } } })
}
