import getPrisma from "@/lib/db"
import { planDsqlWriteBatch } from "@/lib/dsql-backfill"

const RECONCILE_LIMITS = { maxRows: 3_000, maxBytes: 10 * 1024 * 1024 } as const

export class CapacityLedgerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "CapacityLedgerError"
  }
}

type Database = ReturnType<typeof getPrisma>

export async function releaseNowCapacityInTransaction(tx: Database, itemId: string): Promise<void> {
  const reservation = await tx.portfolioCapacityReservation.findUnique({
    where: { roadmapItemId: itemId },
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
    data: { state: "RELEASED", releasedAt: new Date(), updatedAt: new Date() },
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

export async function reconcileAndActivateCapacityPlan(planId: string): Promise<{ reserved: number }> {
  const prisma = getPrisma()
  let cursor: string | undefined
  let reserved = 0
  for (;;) {
    const plan = await prisma.portfolioCapacityPlan.findUnique({ where: { id: planId } })
    if (!plan || plan.state !== "DRAFT") throw new CapacityLedgerError("PLAN_NOT_DRAFT", "Capacity plan must be DRAFT during reconciliation.")
    const rows = await prisma.roadmapItem.findMany({
      where: { workspaceId: plan.workspaceId, horizon: "NOW", ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_LIMITS.maxRows,
    })
    if (rows.length === 0) break
    const batch = planDsqlWriteBatch(rows.map((row) => ({ id: row.id, estimatedBytes: 256 })), RECONCILE_LIMITS)
    await prisma.$transaction(async (tx) => {
      const current = await tx.portfolioCapacityPlan.findUnique({ where: { id: planId } })
      if (!current || current.state !== "DRAFT" || current.version !== plan.version) throw new CapacityLedgerError("CAPACITY_CONFLICT", "Capacity plan changed during reconciliation.")
      await tx.portfolioCapacityReservation.createMany({
        data: batch.map((row) => ({ planId, roadmapItemId: row.id, decisionRecordId: null, units: plan.unitsPerNowItem, state: "ACTIVE" })),
        skipDuplicates: true,
      })
      const claimed = await tx.portfolioCapacityPlan.updateMany({ where: { id: planId, version: plan.version, state: "DRAFT" }, data: { version: plan.version + 1, updatedAt: new Date() } })
      if (claimed.count !== 1) throw new CapacityLedgerError("CAPACITY_CONFLICT", "Capacity reconciliation lost its CAS.")
    })
    reserved += batch.length
    cursor = batch.at(-1)!.id
    if (batch.length < rows.length) continue
    if (rows.length < RECONCILE_LIMITS.maxRows) break
  }
  await prisma.$transaction(async (tx) => {
    const plan = await tx.portfolioCapacityPlan.findUnique({ where: { id: planId } })
    if (!plan || plan.state !== "DRAFT") throw new CapacityLedgerError("PLAN_NOT_DRAFT", "Capacity plan is not activatable.")
    const [nowCount, activeCount, activeUnits, drift] = await Promise.all([
      tx.roadmapItem.count({ where: { workspaceId: plan.workspaceId, horizon: "NOW" } }),
      tx.portfolioCapacityReservation.count({ where: { planId, state: "ACTIVE" } }),
      tx.portfolioCapacityReservation.aggregate({ where: { planId, state: "ACTIVE" }, _sum: { units: true } }),
      tx.portfolioCapacityReservation.findFirst({ where: { planId, state: "ACTIVE", roadmapItem: { is: { horizon: { not: "NOW" } } } } }),
    ])
    if (nowCount !== activeCount || drift) throw new CapacityLedgerError("CAPACITY_DRIFT", "Every existing NOW item must have exactly one active reservation before activation.")
    if (activeCount > plan.nowLimit || (activeUnits._sum.units ?? 0) > plan.availableUnits) {
      throw new CapacityLedgerError("CAPACITY_EXCEEDED", "Existing NOW commitments exceed the configured workspace capacity.")
    }
    const activated = await tx.portfolioCapacityPlan.updateMany({ where: { id: planId, version: plan.version, state: "DRAFT" }, data: { state: "ACTIVE", version: plan.version + 1, updatedAt: new Date() } })
    if (activated.count !== 1) throw new CapacityLedgerError("CAPACITY_CONFLICT", "Capacity plan activation lost its CAS.")
  })
  return { reserved }
}
