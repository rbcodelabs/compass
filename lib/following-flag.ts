import type { AppPrismaClient } from "@/lib/db"
import { followingTablesExist, resetFeatureTablesCache } from "@/lib/feature-tables"
import { isModuleEnabled } from "@/lib/modules/server"

/**
 * The Following and in-app notifications gate. Following is the workspace module `following` (Settings > Modules); the other half of
 * "available" is that the additive tables exist (lib/feature-tables.ts), so the code can deploy before migration 068 is applied. Off,
 * every entry point is a no-op or hidden. Rolling back is turning the module off; the additive tables can stay.
 */

/** The `following` module is enabled for the workspace AND both tables exist. */
export async function followingAvailable(prisma: AppPrismaClient, workspaceId: string): Promise<boolean> {
  if (!(await isModuleEnabled(workspaceId, "following"))) return false
  return followingTablesExist(prisma)
}

/** Test seam: forget the cached positive availability answer. */
export function resetFollowingAvailabilityCache(): void {
  resetFeatureTablesCache()
}
