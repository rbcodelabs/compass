import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  committed: { entry: { id: "entry", status: "PENDING", acceptedObjectId: null as string | null, resolvedById: null as string | null }, opportunities: [] as string[], proposals: [] as string[] },
  roundState: "OPEN",
}))

const prisma = vi.hoisted(() => ({
  cardSortNewEntry: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  cardSortRound: { updateMany: vi.fn() },
  cardSortProposal: { upsert: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/card-sort", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/card-sort")>(),
  loadRound: vi.fn(async () => ({
    id: "round", workspaceId: "workspace", objectType: "OPPORTUNITY", state: state.roundState,
    createdById: "facilitator", fieldDefinitionId: "field",
  })),
  loadFactor: vi.fn(async () => ({ name: "Timing", options: [{ value: "now", label: "Now" }] })),
}))
vi.mock("@/lib/opportunity-create", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/opportunity-create")>(),
  createOpportunityWithLinks: vi.fn(async () => {
    state.committed.opportunities.push("opportunity")
    return { id: "opportunity" }
  }),
}))

import { acceptCardSortNewEntry, proposeCardSortNewEntry, withdrawCardSortNewEntry } from "@/lib/card-sort-new-entries"

describe("acceptCardSortNewEntry atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.committed = { entry: { id: "entry", status: "PENDING", acceptedObjectId: null, resolvedById: null }, opportunities: [], proposals: [] }
    state.roundState = "OPEN"
    prisma.cardSortNewEntry.findFirst.mockImplementation(async () => ({
      ...state.committed.entry, roundId: "round", userId: "participant", title: "New idea",
      description: null, suggestedValue: "now",
    }))
    prisma.cardSortNewEntry.updateMany.mockImplementation(async () => {
      state.committed.entry.status = "ACCEPTED"
      state.committed.entry.resolvedById = "facilitator"
      return { count: 1 }
    })
    prisma.cardSortNewEntry.update.mockRejectedValue(new Error("injected finalization failure"))
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 1 })
    prisma.cardSortProposal.upsert.mockImplementation(async () => { state.committed.proposals.push("proposal") })
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
      const snapshot = structuredClone(state.committed)
      try { return await callback(prisma) }
      catch (error) { state.committed = snapshot; throw error }
    })
  })

  it("rolls back the claim and opportunity when finalization fails", async () => {
    await expect(acceptCardSortNewEntry({ workspaceId: "workspace", roundId: "round", userId: "facilitator", entryId: "entry" }))
      .rejects.toThrow("injected finalization failure")

    expect(prisma.$transaction).toHaveBeenCalledOnce()
    expect(state.committed).toEqual({
      entry: { id: "entry", status: "PENDING", acceptedObjectId: null, resolvedById: null },
      opportunities: [],
      proposals: [],
    })
  })

  it("accepts an entry from an already revealed round without recording its suggestion", async () => {
    state.roundState = "REVEALED"
    prisma.cardSortNewEntry.update.mockImplementation(async () => {
      state.committed.entry.acceptedObjectId = "opportunity"
    })

    await expect(acceptCardSortNewEntry({ workspaceId: "workspace", roundId: "round", userId: "facilitator", entryId: "entry" }))
      .resolves.toEqual({ entryId: "entry", opportunityId: "opportunity", suggestionRecorded: false })

    expect(state.committed.entry).toMatchObject({ status: "ACCEPTED", acceptedObjectId: "opportunity" })
    expect(prisma.cardSortProposal.upsert).not.toHaveBeenCalled()
  })

  it("does not claim or create when close wins the acceptance race", async () => {
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 0 })

    await expect(acceptCardSortNewEntry({ workspaceId: "workspace", roundId: "round", userId: "facilitator", entryId: "entry" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })

    expect(prisma.cardSortNewEntry.updateMany).not.toHaveBeenCalled()
    expect(state.committed.opportunities).toEqual([])
  })

  it("does not create or withdraw entries after reveal wins the state race", async () => {
    prisma.cardSortRound.updateMany.mockResolvedValue({ count: 0 })

    await expect(proposeCardSortNewEntry({ workspaceId: "workspace", roundId: "round", userId: "participant", title: "Idea" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })
    await expect(withdrawCardSortNewEntry({ workspaceId: "workspace", roundId: "round", userId: "participant", entryId: "entry" }))
      .rejects.toMatchObject({ code: "WRONG_STATE" })

    expect(prisma.cardSortNewEntry.create).not.toHaveBeenCalled()
    expect(prisma.cardSortNewEntry.deleteMany).not.toHaveBeenCalled()
  })
})
