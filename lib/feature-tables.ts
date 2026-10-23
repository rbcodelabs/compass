import type { AppPrismaClient } from "@/lib/db"
import getPrisma from "@/lib/db"
import { hasToolTransaction } from "@/lib/mcp-tool-db"

/**
 * Whether the additive tables behind Workspace Updates and Following exist yet. Whether a WORKSPACE has the feature on is a module
 * (lib/modules); this is the other half of "available", so the code can deploy before migrations 060 and 068 are applied.
 *
 * Only a positive answer is cached, so a feature comes alive on its own once its migration lands, without a restart. A missing table
 * (Prisma P2021) reads as "not there"; any other error propagates. Callers pass a plain client, never a caller's transaction: a
 * missing-table error would abort that transaction (an MCP tool's client is already inside one, hence the substitution below).
 */

const isMissingTable = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2021"

let followingKnownToExist = false
let updatesKnownToExist = false

export async function followingTablesExist(prisma: AppPrismaClient): Promise<boolean> {
  if (followingKnownToExist) return true
  try {
    await Promise.all([
      prisma.follow.findFirst({ select: { id: true } }),
      prisma.notification.findFirst({ select: { id: true } }),
    ])
    followingKnownToExist = true
    return true
  } catch (error) {
    if (isMissingTable(error)) return false
    throw error
  }
}

export async function workspaceUpdatesTablesExist(prisma: AppPrismaClient): Promise<boolean> {
  if (updatesKnownToExist) return true
  const database = hasToolTransaction() ? getPrisma() : prisma
  try {
    await Promise.all([
      database.workspaceUpdatesState.findFirst({ select: { workspaceId: true } }),
      database.workspaceUpdateEvent.findFirst({ select: { id: true } }),
      database.workspaceUpdatesReadState.findFirst({ select: { id: true } }),
    ])
    updatesKnownToExist = true
    return true
  } catch (error) {
    if (isMissingTable(error)) return false
    throw error
  }
}

/** Test seam: forget the cached positive answers. */
export function resetFeatureTablesCache(): void {
  followingKnownToExist = false
  updatesKnownToExist = false
}
