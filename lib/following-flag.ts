import type { AppPrismaClient } from "@/lib/db"

/**
 * FOLLOWING_ENABLED gate for Following and in-app notifications, modeled on
 * WORKSPACE_UPDATES_ENABLED. Off, every entry point is a no-op or hidden, so the
 * code can deploy before migration 068 is applied. Rolling back is turning the
 * flag off; the additive tables can stay.
 */
export function followingEnabled(): boolean {
  return process.env.FOLLOWING_ENABLED === "1"
}

let tablesKnownToExist = false

/**
 * Flag on AND both tables exist. Only a positive answer is cached, so the feature
 * comes alive on its own once the migration lands without a restart. Must be
 * called with a plain client, never inside a caller's transaction: a missing
 * table error would abort that transaction.
 */
export async function followingAvailable(prisma: AppPrismaClient): Promise<boolean> {
  if (!followingEnabled()) return false
  if (tablesKnownToExist) return true
  try {
    await Promise.all([
      prisma.follow.findFirst({ select: { id: true } }),
      prisma.notification.findFirst({ select: { id: true } }),
    ])
    tablesKnownToExist = true
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2021") return false
    throw error
  }
}

/** Test seam: forget the cached positive availability answer. */
export function resetFollowingAvailabilityCache(): void {
  tablesKnownToExist = false
}
