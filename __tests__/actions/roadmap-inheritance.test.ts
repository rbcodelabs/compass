import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Inheritance wiring of the roadmap UI actions: create (add), promote a solution, promote feedback (no
 * link, so no hook) and the card save (hook only when the opportunity actually changes to a new value).
 */
const m = vi.hoisted(() => ({ auth: vi.fn(), apply: vi.fn() }))

vi.mock("@/lib/custom-field-inheritance", () => ({ applyInheritanceRules: m.apply, applyInheritanceForSourceValue: vi.fn() }))

const mockRoadmapItem = { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() }
const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  solution: { findFirst: vi.fn() },
  feedbackItem: { findFirst: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  opportunity: { findFirst: vi.fn() },
  squad: { findFirst: vi.fn() },
  experiment: { findFirst: vi.fn() },
  keyResult: { findFirst: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: vi.fn(() => mockPrisma) }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock())

import { addRoadmapItem, editRoadmapItem, promoteFeedbackToRoadmap, promoteToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions"

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "user-1" } })
  m.apply.mockResolvedValue({ applied: [], skipped: [] })
  mockPrisma.$transaction.mockImplementation((fn: (db: typeof mockPrisma) => unknown) => fn(mockPrisma))
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)
  mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "member-1" })
  mockPrisma.opportunity.findFirst.mockResolvedValue({ id: "opp-1", title: "Opp" })
  mockPrisma.solution.findFirst.mockResolvedValue({ id: "sol-1", title: "Sol", opportunityId: "opp-1", opportunity: { id: "opp-1", squadId: null } })
  mockPrisma.feedbackItem.findFirst.mockResolvedValue({ title: "Broken login" })
  mockRoadmapItem.findFirst.mockResolvedValue(null)
  mockRoadmapItem.create.mockResolvedValue({ id: "item-1", title: "T" })
})

describe("roadmap UI creation", () => {
  it("addRoadmapItem runs the hook right after the create, in the same transaction, with its links", async () => {
    await addRoadmapItem("ws-1", { title: "Plan", horizon: "NOW", opportunityId: "opp-1" })

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: "ws-1", targetObjectType: "ROADMAP_ITEM", targetId: "item-1", links: { opportunityId: "opp-1", solutionId: null } })
    expect(m.apply.mock.invocationCallOrder[0]).toBeGreaterThan(mockRoadmapItem.create.mock.invocationCallOrder[0])
  })

  it("promoteToRoadmap passes both the solution and its opportunity", async () => {
    await promoteToRoadmap("sol-1", "ws-1", "NOW", null, null)

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: "ws-1", targetObjectType: "ROADMAP_ITEM", targetId: "item-1", links: { opportunityId: "opp-1", solutionId: "sol-1" } })
  })

  it("promoteFeedbackToRoadmap carries no opportunity or solution, so there is nothing to inherit", async () => {
    await promoteFeedbackToRoadmap("fb-1", "ws-1", "NOW")

    expect(mockRoadmapItem.create).toHaveBeenCalledTimes(1)
    expect(m.apply).not.toHaveBeenCalled()
  })

  it("a failed inheritance aborts nothing silently: the hook runs inside the mutation so its error rolls the create back", async () => {
    m.apply.mockRejectedValue(new Error("db down"))
    await expect(addRoadmapItem("ws-1", { title: "Plan", horizon: "NOW", opportunityId: "opp-1" })).rejects.toThrow("db down")
  })
})

describe("roadmap card save (editRoadmapItem)", () => {
  const base = { title: "T", description: null, startDate: null, endDate: null, isPrivate: false }
  beforeEach(() => {
    mockRoadmapItem.findFirst.mockResolvedValue({ id: "item-1", startDate: null, endDate: null, opportunityId: "opp-1", solutionId: "sol-9", opportunity: { id: "opp-1", title: "Existing" } })
    mockRoadmapItem.update.mockResolvedValue({ id: "item-1", opportunityId: "opp-2" })
    mockPrisma.opportunity.findFirst.mockResolvedValue({ id: "opp-2", title: "New" })
  })

  it("runs the hook when the opportunity changes to a new non-null value", async () => {
    await editRoadmapItem("item-1", "ws-1", { ...base, opportunityId: "opp-2" })

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: "ws-1", targetObjectType: "ROADMAP_ITEM", targetId: "item-1", links: { opportunityId: "opp-2", solutionId: "sol-9" } })
    expect(m.apply.mock.invocationCallOrder[0]).toBeGreaterThan(mockRoadmapItem.update.mock.invocationCallOrder[0])
  })

  it.each([
    ["re-linked to the same opportunity", "opp-1"],
    ["unlinked", null],
  ])("does nothing when the opportunity is %s", async (_label, opportunityId) => {
    await editRoadmapItem("item-1", "ws-1", { ...base, opportunityId })

    expect(m.apply).not.toHaveBeenCalled()
  })
})
