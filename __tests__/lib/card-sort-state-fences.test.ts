import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  cardSortRound: { findUnique: vi.fn(), updateMany: vi.fn() },
  cardSortProposal: { upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { proposeCardSortMove, setCardSortRoundState, withdrawCardSortProposal } from "@/lib/card-sort"

describe("card-sort state transition fences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
    prisma.cardSortRound.findUnique.mockResolvedValue({
      id: "round", workspaceId: "workspace", state: "OPEN", createdById: "facilitator",
      fieldDefinitionId: "field", fieldDefinition: { name: "Priority" },
    })
  })

  it("does not regress a concurrently closed round back to revealed", async () => {
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 0 })

    await expect(setCardSortRoundState({ workspaceId: "workspace", roundId: "round", userId: "facilitator", state: "REVEALED" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })

    expect(prisma.cardSortRound.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ state: "OPEN" }),
    }))
  })

  it("does not write a proposal after reveal wins the state race", async () => {
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 0 })

    await expect(proposeCardSortMove({ workspaceId: "workspace", roundId: "round", userId: "participant", objectId: "object", proposedValue: "now" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })

    expect(prisma.cardSortProposal.upsert).not.toHaveBeenCalled()
  })

  it("does not withdraw a proposal after reveal wins the state race", async () => {
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 0 })

    await expect(withdrawCardSortProposal({ workspaceId: "workspace", roundId: "round", userId: "participant", objectId: "object" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })

    expect(prisma.cardSortProposal.deleteMany).not.toHaveBeenCalled()
  })
})
