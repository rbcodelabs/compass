import getPrisma from "@/lib/db"

export class CapacityLedgerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "CapacityLedgerError"
  }
}

type Database = ReturnType<typeof getPrisma>

export async function releaseNowCapacityInTransaction(tx: Database, itemId: string): Promise<void> {
  const reservation = await tx.portfolioCapacityReservation.findUnique({
    where: { activeRoadmapItemId: itemId },
    include: { plan: true },
  })
  if (!reservation || reservation.state !== "ACTIVE") return
  const claimed = await tx.portfolioCapacityPlan.updateMany({
    where: { id: reservation.planId, version: reservation.plan.version, state: "ACTIVE" },
    data: { version: reservation.plan.version + 1, updatedAt: new Date() },
  })
  if (claimed.count !== 1) throw new CapacityLedgerError("CAPACITY_CONFLICT", "Workspace capacity changed concurrently.")
  await tx.portfolioCapacityReservation.update({
    where: { id: reservation.id },
    data: { state: "RELEASED", activeRoadmapItemId: null, releasedAt: new Date(), updatedAt: new Date() },
  })
}

export async function updateRoadmapItemWithCapacityRelease(
  itemId: string,
  data: { horizon?: string; status?: string; [key: string]: unknown },
) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const item = await tx.roadmapItem.findUnique({ where: { id: itemId }, select: { id: true, horizon: true, status: true } })
    if (!item) throw new CapacityLedgerError("ITEM_NOT_FOUND", "Roadmap item not found.")
    const exitsNow = item.horizon === "NOW" && ((data.horizon !== undefined && data.horizon !== "NOW") || data.status === "ARCHIVED")
    if (exitsNow) await releaseNowCapacityInTransaction(tx as Database, item.id)
    return tx.roadmapItem.update({ where: { id: item.id }, data: { ...data, updatedAt: new Date() } })
  })
}
