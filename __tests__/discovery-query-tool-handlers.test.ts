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
        roadmapItems: { select: { id: true, horizon: true, status: true } },
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
