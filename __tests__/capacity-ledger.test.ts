import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  portfolioCapacityPlan: { findUnique: vi.fn(), updateMany: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn(), createMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  roadmapItem: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
}
const prisma = { ...tx, $transaction: vi.fn((fn: (database: typeof tx) => unknown) => fn(tx)) }
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { reconcileAndActivateCapacityPlan, updateRoadmapItemWithCapacityRelease } from "@/lib/capacity-ledger"

describe("workspace capacity ledger", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prisma.$transaction.mockImplementation((fn: (database: typeof tx) => unknown) => fn(tx))
    tx.portfolioCapacityPlan.updateMany.mockResolvedValue({ count: 1 })
  })

  it("initializes reservations for legacy NOW items before activating a plan", async () => {
    tx.portfolioCapacityPlan.findUnique
      .mockResolvedValueOnce({ id: "plan-1", workspaceId: "ws-1", state: "DRAFT", version: 0 })
      .mockResolvedValueOnce({ id: "plan-1", workspaceId: "ws-1", state: "DRAFT", version: 0 })
      .mockResolvedValueOnce({ id: "plan-1", workspaceId: "ws-1", state: "DRAFT", version: 1 })
    tx.roadmapItem.findMany.mockResolvedValue([{ id: "legacy-now-1" }])
    tx.roadmapItem.count.mockResolvedValue(1)
    tx.portfolioCapacityReservation.count.mockResolvedValue(1)
    tx.portfolioCapacityReservation.findFirst.mockResolvedValue(null)

    await expect(reconcileAndActivateCapacityPlan("plan-1")).resolves.toEqual({ reserved: 1 })

    expect(tx.portfolioCapacityReservation.createMany).toHaveBeenCalledWith({
      data: [{ planId: "plan-1", roadmapItemId: "legacy-now-1", decisionRecordId: null, units: 1, state: "ACTIVE" }],
      skipDuplicates: true,
    })
    expect(tx.portfolioCapacityPlan.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "ACTIVE" }) }))
  })

  it("fails activation when NOW rows and active reservations drift", async () => {
    tx.portfolioCapacityPlan.findUnique
      .mockResolvedValueOnce({ id: "plan-1", workspaceId: "ws-1", state: "DRAFT", version: 0 })
      .mockResolvedValueOnce({ id: "plan-1", workspaceId: "ws-1", state: "DRAFT", version: 0 })
    tx.roadmapItem.findMany.mockResolvedValue([])
    tx.roadmapItem.count.mockResolvedValue(1)
    tx.portfolioCapacityReservation.count.mockResolvedValue(0)
    tx.portfolioCapacityReservation.findFirst.mockResolvedValue(null)

    await expect(reconcileAndActivateCapacityPlan("plan-1")).rejects.toEqual(expect.objectContaining({ code: "CAPACITY_DRIFT" }))
  })

  it("atomically releases the active reservation when an item exits NOW", async () => {
    tx.roadmapItem.findUnique.mockResolvedValue({ id: "item-1", horizon: "NOW", status: "ACTIVE" })
    tx.portfolioCapacityReservation.findUnique.mockResolvedValue({ id: "reservation-1", planId: "plan-1", state: "ACTIVE", plan: { id: "plan-1", version: 3 } })
    tx.roadmapItem.update.mockResolvedValue({ id: "item-1", horizon: "NEXT" })

    await updateRoadmapItemWithCapacityRelease("item-1", { horizon: "NEXT" })

    expect(tx.portfolioCapacityPlan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 3 }), data: expect.objectContaining({ version: 4 }) }))
    expect(tx.portfolioCapacityReservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "RELEASED" }) }))
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
