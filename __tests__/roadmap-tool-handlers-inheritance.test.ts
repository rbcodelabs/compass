/**
 * Inheritance wiring of the roadmap MCP handlers: add_to_roadmap (with and without a solution),
 * promote_to_roadmap and update_roadmap_item each run the shared hook inside their mutation
 * transaction and report what was inherited, without changing the existing response shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const m = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock("@/lib/custom-field-inheritance", () => ({
  applyInheritanceRules: m.apply,
  applyInheritanceForSourceValue: vi.fn(),
}))

const mockRoadmapItem = { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() }
const mockPrisma = {
  workspace: { findUnique: vi.fn() },
  roadmapItem: mockRoadmapItem,
  solution: { findFirst: vi.fn(), findMany: vi.fn() },
  opportunity: { findFirst: vi.fn() },
  keyResult: { findFirst: vi.fn() },
  squad: { findMany: vi.fn(), findFirst: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))
vi.mock("@/lib/work-item-sequence", async () => (await import("./helpers/work-item-sequence-mock")).workItemSequenceMock())

import { createRoadmapItem, promoteSolutionToRoadmap, updateRoadmapItem } from "@/lib/roadmap-tool-handlers"

const WS = "ws-1"
const asActor = <T,>(run: () => Promise<T>) => runWithMcpActor({ userId: "user-1", purpose: "USER" }, run)
const inherited = [{ fieldId: "f-partner", fieldName: "Partner", from: { objectType: "OPPORTUNITY", objectId: "opp-1", fieldId: "f-customer", fieldName: "Customer" }, value: "acme" }]

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((operation: unknown) => Array.isArray(operation) ? Promise.all(operation) : (operation as (db: typeof mockPrisma) => unknown)(mockPrisma))
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: WS, name: "Compass", slug: "compass", organization: { slug: "acme" } })
  m.apply.mockResolvedValue({ applied: inherited, skipped: [] })
})

describe("add_to_roadmap without a solution", () => {
  beforeEach(() => {
    mockRoadmapItem.findFirst.mockResolvedValue(null)
    mockRoadmapItem.create.mockImplementation(({ data }) => Promise.resolve({ id: "item-new", ...data }))
  })

  it("runs the hook in the create transaction with the item's links and reports inheritedFields", async () => {
    const result = await asActor(() => createRoadmapItem({ workspaceId: WS, title: "Plan", horizon: "NOW", opportunityId: "opp-1" }))

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: WS, targetObjectType: "ROADMAP_ITEM", targetId: "item-new", links: { opportunityId: "opp-1", solutionId: null } })
    expect(m.apply.mock.invocationCallOrder[0]).toBeGreaterThan(mockRoadmapItem.create.mock.invocationCallOrder[0])
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: "item-new", title: "Plan", opportunityId: "opp-1", inheritedFields: [{ fieldId: "f-partner", fieldName: "Partner", from: expect.objectContaining({ fieldName: "Customer" }) }] } })
    expect(result.content[0].text).toContain("Partner")
  })

  it("keeps every existing field of the response and reports an empty list when nothing was inherited", async () => {
    m.apply.mockResolvedValue({ applied: [], skipped: [] })
    const result = await asActor(() => createRoadmapItem({ workspaceId: WS, title: "Plan", horizon: "NOW" }))
    expect(result.structuredContent.data).toEqual(expect.objectContaining({ id: "item-new", displayId: expect.anything(), title: "Plan", horizon: "NOW", isPrivate: false, solutionId: null, keyResultId: null, opportunityId: null, squadId: null, inheritedFields: [] }))
  })
})

describe("add_to_roadmap / promote_to_roadmap with a solution", () => {
  const solution = { id: "sol-1", title: "Ship", opportunityId: "opp-1", opportunity: { id: "opp-1", title: "Opp", squadId: null, linkedKeyResultId: null } }
  beforeEach(() => {
    mockPrisma.solution.findMany.mockResolvedValue([solution])
    mockPrisma.solution.findFirst.mockResolvedValue(solution)
    mockPrisma.squad.findMany.mockResolvedValue([])
    mockRoadmapItem.findMany.mockResolvedValue([])
    mockRoadmapItem.findFirst.mockResolvedValue(null)
    mockRoadmapItem.create.mockImplementation(({ data }) => Promise.resolve({ id: "item-sol", ...data }))
    mockRoadmapItem.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({
      id: where.id, title: "Ship", horizon: "NEXT", isPrivate: false, solutionId: "sol-1", keyResultId: null, opportunityId: "opp-1", squadId: null, startDate: null, endDate: null,
    }))
  })

  it("add_to_roadmap fills inherited fields for the new item (both links) and reports them", async () => {
    const result = await asActor(() => createRoadmapItem({ workspaceId: WS, title: "Ship", horizon: "NEXT", solutionId: "sol-1" }))

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: WS, targetObjectType: "ROADMAP_ITEM", targetId: "item-sol", links: { opportunityId: "opp-1", solutionId: "sol-1" } })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { created: true, inheritedFields: [{ fieldId: "f-partner" }] } })
  })

  it("promote_to_roadmap reports inheritedFields next to the existing promotion shape", async () => {
    const result = await asActor(() => promoteSolutionToRoadmap({ workspaceId: WS, solutionId: "sol-1", horizon: "NEXT" }))

    expect(m.apply).toHaveBeenCalledTimes(1)
    expect(result.structuredContent).toMatchObject({ ok: true, data: { created: true, solutionId: "sol-1", opportunityId: "opp-1", opportunityTitle: "Opp", inheritedFields: [{ fieldId: "f-partner" }] } })
  })

  it("an idempotent re-promotion creates nothing, applies nothing and reports no inherited fields", async () => {
    mockRoadmapItem.findMany.mockImplementation(({ where }: { where: { solutionId?: unknown } }) => Promise.resolve(where.solutionId ? [{ id: "existing", solutionId: "sol-1" }] : []))
    const result = await asActor(() => promoteSolutionToRoadmap({ workspaceId: WS, solutionId: "sol-1", horizon: "NEXT" }))

    expect(m.apply).not.toHaveBeenCalled()
    expect(result.structuredContent).toMatchObject({ ok: true, data: { created: false, inheritedFields: [] } })
  })
})

describe("update_roadmap_item", () => {
  beforeEach(() => {
    mockRoadmapItem.findUnique.mockResolvedValue({ id: "item-1", workspaceId: WS, opportunityId: "opp-old", solutionId: null })
    mockPrisma.opportunity.findFirst.mockResolvedValue({ id: "opp-new" })
    mockPrisma.solution.findFirst.mockResolvedValue({ id: "sol-new" })
    mockRoadmapItem.update.mockImplementation(({ data }) => Promise.resolve({ id: "item-1", title: "T", horizon: "NOW", status: "ACTIVE", isPrivate: false, solutionId: null, startDate: null, endDate: null, ...data }))
  })

  it("runs the hook, in the update transaction, when the opportunity changes to a new non-null value", async () => {
    const result = await asActor(() => updateRoadmapItem({ itemId: "item-1", opportunityId: "opp-new" }))

    expect(m.apply).toHaveBeenCalledWith(mockPrisma, { workspaceId: WS, targetObjectType: "ROADMAP_ITEM", targetId: "item-1", links: { opportunityId: "opp-new", solutionId: null } })
    expect(m.apply.mock.invocationCallOrder[0]).toBeGreaterThan(mockRoadmapItem.update.mock.invocationCallOrder[0])
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: "item-1", inheritedFields: [{ fieldId: "f-partner" }] } })
  })

  it("runs the hook when only the solution link changes", async () => {
    await asActor(() => updateRoadmapItem({ itemId: "item-1", solutionId: "sol-new" }))
    expect(m.apply).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ links: { opportunityId: "opp-old", solutionId: "sol-new" } }))
  })

  it.each([
    ["the link is re-sent unchanged", { opportunityId: "opp-old" }],
    ["the link is cleared (unlink does nothing)", { opportunityId: null }],
    ["no link is touched", { title: "Renamed" }],
  ])("does not run the hook when %s", async (_label, patch) => {
    const result = await asActor(() => updateRoadmapItem({ itemId: "item-1", ...patch }))

    expect(m.apply).not.toHaveBeenCalled()
    expect(result.structuredContent).toMatchObject({ ok: true, data: { inheritedFields: [] } })
  })
})
