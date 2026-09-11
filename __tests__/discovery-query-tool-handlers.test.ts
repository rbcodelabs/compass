import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSolution = { findMany: vi.fn() }
const mockAssumption = { findMany: vi.fn() }
const mockPrisma = { solution: mockSolution, assumption: mockAssumption }

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { listAssumptions, listSolutions } from "@/lib/discovery-query-tool-handlers"

function dataOf(result: { structuredContent: { data: unknown } }) {
  return result.structuredContent.data as {
    items: Array<Record<string, unknown>>
    count: number
  }
}

beforeEach(() => vi.clearAllMocks())

describe("listSolutions", () => {
  it("discovers solutions by factual state within one workspace and returns stable joins", async () => {
    mockSolution.findMany.mockResolvedValueOnce([
      {
        id: "solution-1",
        title: "Guided setup",
        status: "VALIDATED",
        opportunityId: "opportunity-1",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        opportunity: {
          id: "opportunity-1",
          title: "Admins struggle to finish setup",
          status: "ACTIVE",
          squadId: "squad-1",
        },
        roadmapItems: [],
      },
    ])

    const result = await listSolutions({
      workspaceId: "workspace-1",
      status: "VALIDATED",
      opportunityStatus: "ACTIVE",
      squadId: "squad-1",
      hasRoadmapItem: false,
    })

    expect(mockSolution.findMany).toHaveBeenCalledWith({
      where: {
        status: "VALIDATED",
        opportunity: {
          workspaceId: "workspace-1",
          status: "ACTIVE",
          squadId: "squad-1",
        },
        roadmapItems: { none: {} },
      },
      include: {
        opportunity: { select: { id: true, title: true, status: true, squadId: true } },
        roadmapItems: {
          select: { id: true, horizon: true, status: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })
    expect(dataOf(result)).toEqual({
      items: [
        {
          id: "solution-1",
          title: "Guided setup",
          status: "VALIDATED",
          opportunityId: "opportunity-1",
          opportunityTitle: "Admins struggle to finish setup",
          opportunityStatus: "ACTIVE",
          squadId: "squad-1",
          roadmapItems: [],
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
      count: 1,
    })
  })

  it("returns an empty successful collection", async () => {
    mockSolution.findMany.mockResolvedValueOnce([])
    const result = await listSolutions({ workspaceId: "workspace-1", status: "IDEA" })
    expect(result.structuredContent.ok).toBe(true)
    expect(dataOf(result)).toEqual({ items: [], count: 0 })
  })
})

describe("listAssumptions", () => {
  it("discovers high-risk untested assumptions under active focus with stable parent IDs", async () => {
    mockAssumption.findMany.mockResolvedValueOnce([
      {
        id: "assumption-1",
        title: "Admins will trust automatic fixes",
        status: "UNTESTED",
        riskLevel: "HIGH",
        solutionId: "solution-1",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
        solution: {
          id: "solution-1",
          title: "Guided setup",
          status: "IDEA",
          opportunity: {
            id: "opportunity-1",
            title: "Admins struggle to finish setup",
            status: "ACTIVE",
            squadId: "squad-1",
          },
        },
        _count: { experiments: 0 },
      },
    ])

    const result = await listAssumptions({
      workspaceId: "workspace-1",
      status: "UNTESTED",
      riskLevel: "HIGH",
      solutionStatus: "IDEA",
      opportunityStatus: "ACTIVE",
      squadId: "squad-1",
    })

    expect(mockAssumption.findMany).toHaveBeenCalledWith({
      where: {
        status: "UNTESTED",
        riskLevel: "HIGH",
        solution: {
          status: "IDEA",
          opportunity: {
            workspaceId: "workspace-1",
            status: "ACTIVE",
            squadId: "squad-1",
          },
        },
      },
      include: {
        solution: {
          select: {
            id: true,
            title: true,
            status: true,
            opportunity: { select: { id: true, title: true, status: true, squadId: true } },
          },
        },
        _count: { select: { experiments: true } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })
    expect(dataOf(result).items[0]).toMatchObject({
      id: "assumption-1",
      status: "UNTESTED",
      riskLevel: "HIGH",
      solutionId: "solution-1",
      opportunityId: "opportunity-1",
      opportunityStatus: "ACTIVE",
      squadId: "squad-1",
      experimentCount: 0,
    })
  })
})

describe("listSolutions recency filtering and sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSolution.findMany.mockResolvedValue([])
  })

  function queryFor() {
    return mockSolution.findMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown }
  }

  it("keeps updatedAt asc plus an id tiebreaker as the default ordering", async () => {
    await listSolutions({ workspaceId: "workspace-1" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
    expect(queryFor().where).not.toHaveProperty("updatedAt")
  })

  it("filters on a closed recency window", async () => {
    await listSolutions({
      workspaceId: "workspace-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where.updatedAt).toEqual({
      gte: new Date("2026-09-01T00:00:00.000Z"),
      lt: new Date("2026-09-10T00:00:00.000Z"),
    })
  })

  it("keeps the recency filter on the solution, not the parent opportunity", async () => {
    await listSolutions({ workspaceId: "workspace-1", updatedSince: "2026-09-01T00:00:00.000Z" })

    // A solution is stale on its own timeline; its opportunity may be fresher.
    expect(queryFor().where.opportunity).toEqual({ workspaceId: "workspace-1" })
    expect(queryFor().where.updatedAt).toEqual({ gte: new Date("2026-09-01T00:00:00.000Z") })
  })

  it("flips to newest-first on recentlyUpdated", async () => {
    await listSolutions({ workspaceId: "workspace-1", sort: "recentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  it("keeps oldest-first on leastRecentlyUpdated", async () => {
    await listSolutions({ workspaceId: "workspace-1", sort: "leastRecentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
  })

  it("preserves the lifecycle filters alongside the recency window", async () => {
    await listSolutions({
      workspaceId: "workspace-1",
      status: "VALIDATED",
      opportunityStatus: "ACTIVE",
      squadId: "squad-1",
      hasRoadmapItem: false,
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where).toEqual({
      status: "VALIDATED",
      opportunity: { workspaceId: "workspace-1", status: "ACTIVE", squadId: "squad-1" },
      roadmapItems: { none: {} },
      updatedAt: { lt: new Date("2026-09-10T00:00:00.000Z") },
    })
  })
})

describe("listAssumptions recency filtering and sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAssumption.findMany.mockResolvedValue([])
  })

  function queryFor() {
    return mockAssumption.findMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown }
  }

  it("keeps updatedAt asc plus an id tiebreaker as the default ordering", async () => {
    await listAssumptions({ workspaceId: "workspace-1" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
    expect(queryFor().where).not.toHaveProperty("updatedAt")
  })

  it("filters on a closed recency window", async () => {
    await listAssumptions({
      workspaceId: "workspace-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where.updatedAt).toEqual({
      gte: new Date("2026-09-01T00:00:00.000Z"),
      lt: new Date("2026-09-10T00:00:00.000Z"),
    })
  })

  it("flips to newest-first on recentlyUpdated", async () => {
    await listAssumptions({ workspaceId: "workspace-1", sort: "recentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  it("keeps oldest-first on leastRecentlyUpdated", async () => {
    await listAssumptions({ workspaceId: "workspace-1", sort: "leastRecentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
  })

  it("preserves the risk and ancestry filters alongside the recency window", async () => {
    await listAssumptions({
      workspaceId: "workspace-1",
      status: "UNTESTED",
      riskLevel: "HIGH",
      solutionStatus: "IDEA",
      opportunityStatus: "EXPLORING",
      squadId: "squad-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
    })

    expect(queryFor().where).toEqual({
      status: "UNTESTED",
      riskLevel: "HIGH",
      solution: {
        status: "IDEA",
        opportunity: { workspaceId: "workspace-1", status: "EXPLORING", squadId: "squad-1" },
      },
      updatedAt: { gte: new Date("2026-09-01T00:00:00.000Z") },
    })
  })
})
