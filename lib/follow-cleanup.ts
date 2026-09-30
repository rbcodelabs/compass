import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"

/**
 * Hygiene deletes for Follow and Notification rows (ADR section 2.4). Read-time
 * membership and access checks stay the authority; these keep the tables from
 * accumulating rows for subjects, members and workspaces that are gone.
 *
 * Every helper works regardless of FOLLOWING_ENABLED and tolerates the tables not
 * existing yet (P2021), exactly like deleteWorkspaceUpdates: a workspace or
 * member delete must still succeed before the migration is applied or after a
 * rollback. They also must not run inside a caller's transaction, because a
 * missing-table error would abort that transaction.
 */

/** Well under Aurora DSQL's 3000-rows-per-transaction limit. */
const DELETE_CHUNK = 1000
const ID_CHUNK = 500

type Delegate = {
  findMany(args: { where: Record<string, unknown>; select: { id: true }; take: number }): Promise<{ id: string }[]>
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>
}

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2021"
}

async function tolerateMissingTables(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (isMissingTable(error)) return
    throw error
  }
}

/** Deletes every matching row in bounded batches so no single statement can exceed the row limit. */
async function deleteInChunks(delegate: Delegate, where: Record<string, unknown>): Promise<void> {
  for (;;) {
    const rows = await delegate.findMany({ where, select: { id: true }, take: DELETE_CHUNK })
    if (rows.length === 0) return
    await delegate.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
    if (rows.length < DELETE_CHUNK) return
  }
}

/**
 * Removes the follow state for deleted subjects: their Follows and every
 * Notification about them. Each subject-delete path calls this once it ships
 * with its type's slice; the registry-completeness test enumerates the registry
 * so a new type cannot skip it.
 */
export async function deleteSubjectFollowState(
  subjectType: string,
  subjectIds: string[],
  prisma: AppPrismaClient = getPrisma(),
): Promise<void> {
  await tolerateMissingTables(async () => {
    for (let i = 0; i < subjectIds.length; i += ID_CHUNK) {
      const where = { subjectType, subjectId: { in: subjectIds.slice(i, i + ID_CHUNK) } }
      await deleteInChunks(prisma.follow as unknown as Delegate, where)
      await deleteInChunks(prisma.notification as unknown as Delegate, where)
    }
  })
}

/** Removes one user's follow state for one workspace, at the member-removal site. */
export async function deleteMemberFollowState(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await tolerateMissingTables(async () => {
    await deleteInChunks(prisma.follow as unknown as Delegate, { workspaceId, userId })
    await deleteInChunks(prisma.notification as unknown as Delegate, { workspaceId, recipientUserId: userId })
  })
}

/** Workspace cascade: every Follow and Notification for the workspace, single-index and chunked. */
export async function deleteWorkspaceNotifications(prisma: AppPrismaClient, workspaceId: string): Promise<void> {
  await tolerateMissingTables(async () => {
    await deleteInChunks(prisma.notification as unknown as Delegate, { workspaceId })
    await deleteInChunks(prisma.follow as unknown as Delegate, { workspaceId })
  })
}
