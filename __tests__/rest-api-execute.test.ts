import { beforeEach, describe, expect, it, vi } from "vitest"

const UUID = "11111111-1111-4111-8111-111111111111"
const FOREIGN = "22222222-2222-4222-8222-222222222222"

const mocks = vi.hoisted(() => ({
  prisma: {
    squad: { findFirst: vi.fn() },
    keyResult: { findFirst: vi.fn() },
    opportunity: { findFirst: vi.fn() },
    solution: { findFirst: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    roadmapItem: { findFirst: vi.fn() },
    feedbackItem: { findFirst: vi.fn() },
  },
  createOpportunity: vi.fn(),
  createTask: vi.fn(),
  updateRoadmapItem: vi.fn(),
  createRoadmapItem: vi.fn(),
  assertWorkspaceMember: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.prisma }))
vi.mock("@/lib/mcp-authz", () => ({
  getMcpActor: () => ({ userId: "user-1", purpose: "USER" }),
  assertWorkspaceMember: mocks.assertWorkspaceMember,
  isServiceActor: () => false,
}))
vi.mock("@/lib/opportunity-tool-handlers", () => ({
  createOpportunity: mocks.createOpportunity,
  updateOpportunity: vi.fn(), updateOpportunityKeyResult: vi.fn(), updateOpportunityStatus: vi.fn(),
}))
vi.mock("@/lib/task-tool-handlers", () => ({
  createTask: mocks.createTask,
  moveTaskStatus: vi.fn(), updateTask: vi.fn(), linkTask: vi.fn(), unlinkTask: vi.fn(),
}))
vi.mock("@/lib/roadmap-tool-handlers", () => ({ updateRoadmapItem: mocks.updateRoadmapItem, createRoadmapItem: mocks.createRoadmapItem }))

import { executeRestRoute, RestNotFoundError } from "@/lib/rest/execute"
import { REST_ROUTES } from "@/lib/rest/registry"

const route = (operationId: string) => {
  const match = REST_ROUTES.find((entry) => entry.operationId === operationId)
  if (!match) throw new Error(`missing route ${operationId}`)
  return match
}

const success = (data: unknown) => ({
  content: [{ type: "text" as const, text: "ok" }],
  structuredContent: { ok: true as const, message: "ok", data },
})

describe("REST domain execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects a foreign opportunity squad before the shared create service runs", async () => {
    mocks.prisma.squad.findFirst.mockResolvedValue(null)

    await expect(executeRestRoute(route("createOpportunity"), {
      params: { workspaceId: UUID }, query: {}, body: { title: "Discovery", squadId: FOREIGN },
    })).rejects.toBeInstanceOf(RestNotFoundError)

    expect(mocks.createOpportunity).not.toHaveBeenCalled()
  })

  it("serializes item read timestamps before response validation", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue({
      id: FOREIGN, workspaceId: UUID, title: "Discovery", description: null,
      customerSegment: null, status: "EXPLORING", squadId: null,
      linkedKeyResultId: null, createdAt: new Date("2026-10-02T00:00:00.000Z"),
      updatedAt: new Date("2026-10-02T01:00:00.000Z"),
    })
    const result = await executeRestRoute(route("getOpportunity"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    }) as { createdAt: string; updatedAt: string }
    expect(result.createdAt).toBe("2026-10-02T00:00:00.000Z")
    expect(result.updatedAt).toBe("2026-10-02T01:00:00.000Z")
  })

  it("normalizes nullable and non-string feedback tags", async () => {
    mocks.prisma.feedbackItem.findFirst.mockResolvedValue({
      id: FOREIGN, workspaceId: UUID, opportunityId: null, title: "Feedback", description: null,
      type: "IDEA", status: "OPEN", voteCount: 0, tags: ["useful", 42, null], submitterName: null,
      submitterEmail: null, createdAt: new Date(), updatedAt: new Date(),
    })
    const result = await executeRestRoute(route("getFeedback"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    }) as { tags: string[] }
    expect(result.tags).toEqual(["useful"])

    mocks.prisma.feedbackItem.findFirst.mockResolvedValueOnce({
      id: FOREIGN, workspaceId: UUID, opportunityId: null, title: "Feedback", description: null,
      type: "IDEA", status: "OPEN", voteCount: 0, tags: null, submitterName: null,
      submitterEmail: null, createdAt: new Date(), updatedAt: new Date(),
    })
    const nullable = await executeRestRoute(route("getFeedback"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    }) as { tags: string[] }
    expect(nullable.tags).toEqual([])
  })

  it("dispatches workspace policies and fails closed for an unknown policy", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("getOpportunity"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.assertWorkspaceMember).toHaveBeenCalledWith(expect.anything(), UUID)

    await expect(executeRestRoute({ ...route("getOpportunity"), authorizationPolicy: "unknown" as never }, {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
  })

  it("calls the same extracted opportunity service used by MCP after tenant validation", async () => {
    const created = { id: FOREIGN }
    mocks.createOpportunity.mockResolvedValue(success(created))
    mocks.prisma.opportunity.findFirst.mockResolvedValue({
      id: FOREIGN, workspaceId: UUID, title: "Discovery", description: null,
      customerSegment: null, status: "EXPLORING", squadId: null,
      linkedKeyResultId: null, createdAt: new Date(), updatedAt: new Date(),
    })

    const result = await executeRestRoute(route("createOpportunity"), {
      params: { workspaceId: UUID }, query: {}, body: { title: "Discovery" },
    })

    expect(mocks.createOpportunity).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: UUID, title: "Discovery", source: "API" }))
    expect(result).toMatchObject({ id: FOREIGN, workspaceId: UUID })
  })

  it("rejects a foreign task assignee before the shared task service runs", async () => {
    mocks.prisma.workspaceMember.findFirst.mockResolvedValue(null)

    await expect(executeRestRoute(route("createTask"), {
      params: { workspaceId: UUID }, query: {}, body: { title: "Ship", assigneeUserId: FOREIGN },
    })).rejects.toBeInstanceOf(RestNotFoundError)

    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("rejects a foreign roadmap relationship before its lifecycle service runs", async () => {
    mocks.prisma.solution.findFirst.mockResolvedValue(null)

    await expect(executeRestRoute(route("updateRoadmapItem"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: { solutionId: FOREIGN },
    })).rejects.toBeInstanceOf(RestNotFoundError)

    expect(mocks.updateRoadmapItem).not.toHaveBeenCalled()
  })

  it("uses the shared roadmap creation service with API provenance", async () => {
    mocks.createRoadmapItem.mockResolvedValue(success({ id: FOREIGN }))
    mocks.prisma.roadmapItem.findFirst.mockResolvedValue({
      id: FOREIGN, workspaceId: UUID, squadId: null, title: "Ship REST", description: null,
      horizon: "NOW", status: "ACTIVE", isPrivate: false, startDate: null, endDate: null,
      solutionId: null, keyResultId: null, opportunityId: null, experimentId: null, feedbackId: null,
      createdAt: new Date(), updatedAt: new Date(),
    })
    await executeRestRoute(route("createRoadmapItem"), {
      params: { workspaceId: UUID }, query: {}, body: { title: "Ship REST", horizon: "NOW" },
    })
    expect(mocks.createRoadmapItem).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: UUID, title: "Ship REST", horizon: "NOW", source: "API" }))
    expect(mocks.assertWorkspaceMember).toHaveBeenCalledWith(expect.objectContaining({ purpose: "USER" }), UUID)
  })
})
