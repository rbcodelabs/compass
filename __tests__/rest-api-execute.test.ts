import { beforeEach, describe, expect, it, vi } from "vitest"

const UUID = "11111111-1111-4111-8111-111111111111"
const FOREIGN = "22222222-2222-4222-8222-222222222222"
const THIRD = "33333333-3333-4333-8333-333333333333"

const mocks = vi.hoisted(() => ({
  prisma: {
    squad: { findFirst: vi.fn() },
    keyResult: { findFirst: vi.fn() },
    opportunity: { findFirst: vi.fn() },
    solution: { findFirst: vi.fn() },
    assumption: { findFirst: vi.fn(), updateMany: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    roadmapItem: { findFirst: vi.fn() },
    feedbackItem: { findFirst: vi.fn() },
    objective: { findFirst: vi.fn() },
    experiment: { findFirst: vi.fn(), updateMany: vi.fn() },
    customFieldDefinition: { findFirst: vi.fn(), findMany: vi.fn() },
    customFieldValue: { findMany: vi.fn() },
    workspace: { findFirst: vi.fn() },
    scoringModel: { findMany: vi.fn() },
  },
  createOpportunity: vi.fn(),
  createTask: vi.fn(),
  updateRoadmapItem: vi.fn(),
  createRoadmapItem: vi.fn(),
  assertWorkspaceMember: vi.fn(),
  updateExperiment: vi.fn(),
  captureWorkspaceMutation: vi.fn(),
  listBindingsPage: vi.fn(),
  listObservationsPage: vi.fn(),
  listScoringModels: vi.fn(),
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
vi.mock("@/lib/experiment-update-tool", () => ({ updateExperiment: mocks.updateExperiment }))
vi.mock("@/lib/workspace-update-mutations", () => ({ captureWorkspaceMutation: mocks.captureWorkspaceMutation }))
vi.mock("@/lib/analytics/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/analytics/service")>(),
  listBindingsPage: mocks.listBindingsPage,
  listObservationsPage: mocks.listObservationsPage,
}))
vi.mock("@/lib/scoring-tool-handlers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/scoring-tool-handlers")>(),
  listScoringModels: mocks.listScoringModels,
}))

import { executeRestRoute, RestConflictError, RestNotFoundError } from "@/lib/rest/execute"
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
    mocks.captureWorkspaceMutation.mockImplementation(async (prisma, _model, _operation, _actor, _id, mutate) => mutate(prisma))
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

  it("scopes objective reads through the objective workspace column", async () => {
    mocks.prisma.objective.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("getObjective"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.prisma.objective.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: FOREIGN, workspaceId: UUID } }))
  })

  it("checks experiment tenant scope before using the shared optimistic update service", async () => {
    mocks.prisma.experiment.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("updateExperiment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {},
      body: { expectedUpdatedAt: "2026-10-02T12:00:00.000Z", title: "Changed" },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.updateExperiment).not.toHaveBeenCalled()
  })

  it("reports a stale experiment update as a conflict", async () => {
    mocks.prisma.experiment.findFirst.mockResolvedValue({ id: FOREIGN })
    mocks.updateExperiment.mockRejectedValue(Object.assign(new Error("stale"), { code: "P2025" }))
    await expect(executeRestRoute(route("updateExperiment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {},
      body: { expectedUpdatedAt: "2026-10-02T12:00:00.000Z", title: "Changed" },
    })).rejects.toBeInstanceOf(RestConflictError)
  })

  it("refuses to conclude an experiment whose assumption parent is outside the workspace", async () => {
    mocks.prisma.experiment.findFirst.mockResolvedValue({ id: FOREIGN, status: "RUNNING", assumptionId: FOREIGN })
    mocks.prisma.assumption.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("concludeExperiment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: { conclusion: "PROCEED", expectedUpdatedAt: "2026-10-02T12:00:00.000Z" },
    })).rejects.toBeInstanceOf(RestNotFoundError)
  })

  it("rejects a stale experiment conclusion before changing its linked assumption", async () => {
    mocks.prisma.experiment.findFirst.mockResolvedValue({ id: FOREIGN, status: "RUNNING", assumptionId: null })
    mocks.prisma.experiment.updateMany.mockResolvedValue({ count: 0 })
    await expect(executeRestRoute(route("concludeExperiment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {},
      body: { conclusion: "PROCEED", expectedUpdatedAt: "2026-10-02T12:00:00.000Z" },
    })).rejects.toBeInstanceOf(RestConflictError)
    expect(mocks.prisma.assumption.findFirst).not.toHaveBeenCalled()
  })

  it("rolls back the experiment conclusion when the linked assumption update fails", async () => {
    let status = "RUNNING"
    mocks.prisma.experiment.findFirst.mockImplementation(async () => ({ id: FOREIGN, workspaceId: UUID, status, assumptionId: FOREIGN }))
    mocks.prisma.experiment.updateMany.mockImplementation(async () => { status = "COMPLETE"; return { count: 1 } })
    mocks.prisma.assumption.findFirst.mockResolvedValue({ id: FOREIGN })
    mocks.prisma.assumption.updateMany.mockRejectedValue(new Error("injected assumption failure"))
    mocks.captureWorkspaceMutation.mockImplementationOnce(async (prisma, _model, _operation, _actor, _id, mutate) => {
      const before = status
      try { return await mutate(prisma) } catch (error) { status = before; throw error }
    })
    await expect(executeRestRoute(route("concludeExperiment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {},
      body: { conclusion: "PROCEED", expectedUpdatedAt: "2026-10-02T12:00:00.000Z" },
    })).rejects.toThrow("injected assumption failure")
    expect(status).toBe("RUNNING")
  })

  it("hides a foreign custom-field definition before the shared value writer runs", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue({ id: FOREIGN })
    mocks.prisma.customFieldDefinition.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("setCustomFieldValue"), {
      params: { workspaceId: UUID, objectType: "OPPORTUNITY", objectId: FOREIGN }, query: {},
      body: { fieldId: FOREIGN, value: "secret" },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.prisma.customFieldDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: FOREIGN, workspaceId: UUID, objectType: "OPPORTUNITY" }, select: { id: true },
    })
  })

  it("continues metric-binding pagination exactly after the cursor boundary", async () => {
    const firstAt = new Date("2026-10-02T12:00:00.000Z")
    mocks.listBindingsPage
      .mockResolvedValueOnce({ items: [{ id: UUID, createdAt: firstAt }], next: { id: UUID, at: firstAt } })
      .mockResolvedValueOnce({ items: [{ id: FOREIGN, createdAt: new Date("2026-10-02T11:00:00.000Z") }], next: null })
    const query = { targetType: "EXPERIMENT", targetId: FOREIGN, limit: 1 }
    const first = await executeRestRoute(route("listMetricBindings"), { params: { workspaceId: UUID }, query, body: undefined }) as { nextCursor: string }
    await executeRestRoute(route("listMetricBindings"), { params: { workspaceId: UUID }, query: { ...query, cursor: first.nextCursor }, body: undefined })
    expect(mocks.listBindingsPage).toHaveBeenLastCalledWith(expect.anything(), UUID, { targetType: "EXPERIMENT", targetId: FOREIGN }, {
      limit: 1, cursor: { id: UUID, at: firstAt },
    })
  })

  it("continues metric-observation pagination exactly after the cursor boundary", async () => {
    const firstAt = new Date("2026-10-02T12:00:00.000Z")
    mocks.listObservationsPage
      .mockResolvedValueOnce({ items: [{ id: UUID, retrievedAt: firstAt }], next: { id: UUID, at: firstAt } })
      .mockResolvedValueOnce({ items: [{ id: FOREIGN, retrievedAt: new Date("2026-10-02T11:00:00.000Z") }], next: null })
    const first = await executeRestRoute(route("listMetricObservations"), { params: { workspaceId: UUID, id: FOREIGN }, query: { limit: 1 }, body: undefined }) as { nextCursor: string }
    await executeRestRoute(route("listMetricObservations"), { params: { workspaceId: UUID, id: FOREIGN }, query: { limit: 1, cursor: first.nextCursor }, body: undefined })
    expect(mocks.listObservationsPage).toHaveBeenLastCalledWith(expect.anything(), UUID, FOREIGN, {
      limit: 1, cursor: { id: UUID, at: firstAt },
    })
  })

  it("paginates custom-field definitions in configured display order and returns an empty value collection", async () => {
    mocks.prisma.customFieldDefinition.findMany
      .mockResolvedValueOnce([
        { id: UUID, name: "Tier", fieldType: "TEXT", objectType: "OPPORTUNITY", options: null, sharedOptionSetId: null, required: false, order: 1, sharedOptionSet: null },
        { id: FOREIGN, name: "Area", fieldType: "TEXT", objectType: "OPPORTUNITY", options: null, sharedOptionSetId: null, required: false, order: 2, sharedOptionSet: null },
      ])
      .mockResolvedValueOnce([
        { id: FOREIGN, name: "Area", fieldType: "TEXT", objectType: "OPPORTUNITY", options: null, sharedOptionSetId: null, required: false, order: 2, sharedOptionSet: null },
      ])
      .mockResolvedValueOnce([])
    const definitions = await executeRestRoute(route("listCustomFieldDefinitions"), {
      params: { workspaceId: UUID }, query: { objectType: "OPPORTUNITY", limit: 1 }, body: undefined,
    }) as { items: unknown[]; nextCursor: string | null }
    expect(definitions.items).toHaveLength(1)
    expect(definitions.nextCursor).toEqual(expect.any(String))
    expect(mocks.prisma.customFieldDefinition.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: [{ objectType: "asc" }, { order: "asc" }, { id: "asc" }], take: 2,
    }))
    const continued = await executeRestRoute(route("listCustomFieldDefinitions"), {
      params: { workspaceId: UUID }, query: { objectType: "OPPORTUNITY", limit: 1, cursor: definitions.nextCursor }, body: undefined,
    }) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(continued).toMatchObject({ items: [{ id: FOREIGN }], nextCursor: null })
    expect(mocks.prisma.customFieldDefinition.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ workspaceId: UUID, objectType: "OPPORTUNITY", OR: [
        { objectType: { gt: "OPPORTUNITY" } },
        { objectType: "OPPORTUNITY", order: { gt: 1 } },
        { objectType: "OPPORTUNITY", order: 1, id: { gt: UUID } },
      ] }), take: 2,
    }))

    mocks.prisma.opportunity.findFirst.mockResolvedValue({ id: FOREIGN })
    const values = await executeRestRoute(route("listCustomFieldValues"), {
      params: { workspaceId: UUID, objectType: "OPPORTUNITY", objectId: FOREIGN }, query: { limit: 1 }, body: undefined,
    })
    expect(values).toEqual({ items: [], nextCursor: null })
    expect(mocks.prisma.customFieldValue.findMany).not.toHaveBeenCalled()
  })

  it("recovers the second custom-field page by ID when display orders are equal", async () => {
    const row = (id: string, name: string, order: number) => ({
      id, name, fieldType: "TEXT", objectType: "OPPORTUNITY", options: null,
      sharedOptionSetId: null, required: false, order, sharedOptionSet: null,
    })
    mocks.prisma.opportunity.findFirst.mockResolvedValue({ id: THIRD })
    mocks.prisma.customFieldDefinition.findMany
      .mockResolvedValueOnce([row(UUID, "Tier", 1), row(FOREIGN, "Area", 1)])
      .mockResolvedValueOnce([row(FOREIGN, "Area", 1)])
    mocks.prisma.customFieldValue.findMany
      .mockResolvedValueOnce([{ fieldId: UUID, value: "Enterprise" }])
      .mockResolvedValueOnce([])

    const first = await executeRestRoute(route("listCustomFieldValues"), {
      params: { workspaceId: UUID, objectType: "OPPORTUNITY", objectId: THIRD }, query: { limit: 1 }, body: undefined,
    }) as { items: Array<{ id: string; currentValue: unknown }>; nextCursor: string }
    expect(first.items).toEqual([expect.objectContaining({ id: UUID, currentValue: "Enterprise" })])
    const second = await executeRestRoute(route("listCustomFieldValues"), {
      params: { workspaceId: UUID, objectType: "OPPORTUNITY", objectId: THIRD }, query: { limit: 1, cursor: first.nextCursor }, body: undefined,
    })
    expect(second).toEqual({ items: [expect.objectContaining({ id: FOREIGN, currentValue: null })], nextCursor: null })
    expect(mocks.prisma.customFieldDefinition.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ workspaceId: UUID, objectType: "OPPORTUNITY", OR: [
        { order: { gt: 1 } }, { order: 1, id: { gt: UUID } },
      ] }),
      orderBy: [{ order: "asc" }, { id: "asc" }], take: 2,
    }))
  })

  it("returns an empty scoring-model REST collection with the default 200 status", async () => {
    mocks.prisma.workspace.findFirst.mockResolvedValue({ organization: { id: UUID, slug: "acme" } })
    mocks.listScoringModels.mockResolvedValue(success({ items: [], count: 0 }))
    mocks.prisma.scoringModel.findMany.mockResolvedValue([])
    const scoringRoute = route("listScoringModels")
    const result = await executeRestRoute(scoringRoute, { params: { workspaceId: UUID }, query: {}, body: undefined })
    expect(scoringRoute.status ?? 200).toBe(200)
    expect(result).toEqual({ items: [], nextCursor: null })
  })
})
