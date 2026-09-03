import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  portfolioCapacityPlan: { findUnique: vi.fn(), updateMany: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn(), createMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn() },
  roadmapItem: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
}
const prisma = { ...tx, $transaction: vi.fn((fn: (database: typeof tx) => unknown) => fn(tx)) }
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { updateRoadmapItemWithCapacityRelease } from "@/lib/capacity-ledger"

describe("workspace capacity ledger", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prisma.$transaction.mockImplementation((fn: (database: typeof tx) => unknown) => fn(tx))
    tx.portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 1 })
    tx.portfolioCapacityReservation.aggregate.mockResolvedValue({ _sum: { units: 0 } })
  })

  it("atomically releases the active reservation when an item exits NOW", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue({ id: "item-1", horizon: "NOW", status: "ACTIVE" })
    tx.portfolioCapacityReservation.findUnique.mockResolvedValue({ id: "reservation-1", planId: "plan-1", state: "ACTIVE", plan: { id: "plan-1", version: 3 } })
    tx.roadmapItem.update.mockResolvedValue({ id: "item-1", horizon: "NEXT" })

    await updateRoadmapItemWithCapacityRelease("item-1", { horizon: "NEXT" })

    expect(tx.portfolioCapacityPlan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 3 }), data: expect.objectContaining({ version: 4 }) }))
    expect(tx.portfolioCapacityReservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "RELEASED", activeRoadmapItemId: null }) }))
    expect(tx.roadmapItem.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ horizon: "NEXT" }) }))
  })

  it("rolls back an exit when a concurrent capacity mutation wins CAS", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue({ id: "item-1", horizon: "NOW", status: "ACTIVE" })
    tx.portfolioCapacityReservation.findUnique.mockResolvedValue({ id: "reservation-1", planId: "plan-1", state: "ACTIVE", plan: { id: "plan-1", version: 3 } })
    tx.portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 0 })

    await expect(updateRoadmapItemWithCapacityRelease("item-1", { horizon: "NEXT" })).rejects.toEqual(expect.objectContaining({ code: "CAPACITY_CONFLICT" }))
    expect(tx.portfolioCapacityReservation.update).not.toHaveBeenCalled()
    expect(tx.roadmapItem.update).not.toHaveBeenCalled()
  })
})
