import { beforeEach, describe, expect, it, vi } from "vitest"

const UUID = "11111111-1111-4111-8111-111111111111"
const FOREIGN = "22222222-2222-4222-8222-222222222222"
const THIRD = "33333333-3333-4333-8333-333333333333"

const mocks = vi.hoisted(() => ({
  actor: { current: { userId: "user-1", purpose: "USER" as const } as { userId: string | null; purpose: "USER" | "SERVICE" | "AGENT" | "AGENT_TURN" } },
  prisma: {
    squad: { findFirst: vi.fn() },
    keyResult: { findFirst: vi.fn() },
    opportunity: { findFirst: vi.fn() },
    solution: { findFirst: vi.fn() },
    assumption: { findFirst: vi.fn(), updateMany: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    task: { findFirst: vi.fn(), count: vi.fn() },
    roadmapItem: { findFirst: vi.fn() },
    feedbackItem: { findFirst: vi.fn() },
    objective: { findFirst: vi.fn() },
    experiment: { findFirst: vi.fn(), updateMany: vi.fn() },
    customFieldDefinition: { findFirst: vi.fn(), findMany: vi.fn() },
    customFieldValue: { findMany: vi.fn() },
    workspace: { findFirst: vi.fn() },
    scoringModel: { findMany: vi.fn() },
    doc: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    docVersion: { findFirst: vi.fn(), findMany: vi.fn() },
    comment: { findFirst: vi.fn(), findMany: vi.fn() },
    docComment: { findFirst: vi.fn() },
    artifact: { findFirst: vi.fn() },
    reviewRequest: { findFirst: vi.fn(), findMany: vi.fn() },
    solutionComment: { findFirst: vi.fn() },
    launchChecklistItem: { findFirst: vi.fn() },
    releaseRun: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
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
  getDoc: vi.fn(),
  updateLaunchChecklistItem: vi.fn(),
  assertWorkspaceAdmin: vi.fn(),
  requestReleaseAuthorization: vi.fn(),
  listNotifications: vi.fn(),
  unreadCount: vi.fn(),
  listDecisions: vi.fn(),
  createComment: vi.fn(),
  updateCommentBody: vi.fn(),
  setCommentStatus: vi.fn(),
  createDocCommentCore: vi.fn(),
  updateDocComment: vi.fn(),
  deleteDocComment: vi.fn(),
  resolveDocComment: vi.fn(),
  reopenDocComment: vi.fn(),
  deleteBrowserComment: vi.fn(),
  getResearchStudy: vi.fn(),
  listResearchStudies: vi.fn(),
  listResearchSessions: vi.fn(),
  getResearchSession: vi.fn(),
  listResearchSyntheses: vi.fn(),
  activateResearchStudy: vi.fn(),
  storeAgentStudySynthesis: vi.fn(),
  researchParticipantUrl: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.prisma }))
vi.mock("@/lib/mcp-authz", () => ({
  getMcpActor: () => mocks.actor.current,
  assertWorkspaceMember: mocks.assertWorkspaceMember,
  assertWorkspaceAdmin: mocks.assertWorkspaceAdmin,
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
vi.mock("@/lib/roadmap-tool-handlers", () => ({ updateRoadmapItem: mocks.updateRoadmapItem, createRoadmapItem: mocks.createRoadmapItem, updateLaunchChecklistItem: mocks.updateLaunchChecklistItem, setLaunchTier: vi.fn(), getLaunchChecklist: vi.fn() }))
vi.mock("@/lib/doc-tool-handlers", () => ({ getDoc: mocks.getDoc, listDocs: vi.fn(), createDoc: vi.fn(), updateDoc: vi.fn() }))
vi.mock("@/lib/decision-tool-handlers", () => ({ requestReleaseAuthorization: mocks.requestReleaseAuthorization, requestDecision: vi.fn(), listDecisions: mocks.listDecisions, getDecision: vi.fn(), getReviewRequest: vi.fn(), listReviewRequests: vi.fn() }))
vi.mock("@/lib/comments", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/comments")>(), createComment: mocks.createComment, updateCommentBody: mocks.updateCommentBody, setCommentStatus: mocks.setCommentStatus }))
vi.mock("@/lib/doc-comments", () => ({ createDocCommentCore: mocks.createDocCommentCore }))
vi.mock("@/lib/doc-comment-tool-handlers", () => ({ getDocComment: vi.fn(), updateDocComment: mocks.updateDocComment, deleteDocComment: mocks.deleteDocComment, resolveDocComment: mocks.resolveDocComment, reopenDocComment: mocks.reopenDocComment }))
vi.mock("@/lib/comment-browser", () => ({ deleteBrowserComment: mocks.deleteBrowserComment }))
vi.mock("@/lib/notifications", () => ({ listNotifications: mocks.listNotifications, unreadCount: mocks.unreadCount }))
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
vi.mock("@/lib/research-study-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/research-study-service")>(),
  getResearchStudy: mocks.getResearchStudy,
  listResearchStudies: mocks.listResearchStudies,
  listResearchSessions: mocks.listResearchSessions,
  getResearchSession: mocks.getResearchSession,
  listResearchSyntheses: mocks.listResearchSyntheses,
  activateResearchStudy: mocks.activateResearchStudy,
}))
vi.mock("@/lib/research-analysis-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/research-analysis-service")>(),
  storeAgentStudySynthesis: mocks.storeAgentStudySynthesis,
}))
vi.mock("@/lib/compass-url", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/compass-url")>(),
  researchParticipantUrl: mocks.researchParticipantUrl,
}))

import { executeRestRoute, RestConflictError, RestCursorError, RestForbiddenError, RestNotFoundError, RestValidationError } from "@/lib/rest/execute"
import { REST_ROUTES } from "@/lib/rest/registry"
import { ResearchCursorError, ResearchStudyError } from "@/lib/research-study-service"

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
    mocks.actor.current = { userId: "user-1", purpose: "USER" }
    mocks.captureWorkspaceMutation.mockImplementation(async (prisma, _model, _operation, _actor, _id, mutate) => mutate(prisma))
    mocks.researchParticipantUrl.mockImplementation((token: string) => `https://compass.example/research/${token}`)
  })

  it("denies non-human callers before Phase 4 privileged mutations execute", async () => {
    mocks.actor.current = { userId: "user-1", purpose: "AGENT" }
    await expect(executeRestRoute(route("createCardSortRound"), {
      params: { workspaceId: UUID }, query: {}, body: { name: "Priorities", fieldDefinitionId: FOREIGN },
    })).rejects.toBeInstanceOf(RestForbiddenError)
    expect(mocks.assertWorkspaceMember).not.toHaveBeenCalled()
  })

  it("rejects synthesis creation when the study is not under the path workspace", async () => {
    mocks.getResearchStudy.mockRejectedValue(new ResearchStudyError("Study not found"))

    await expect(executeRestRoute(route("createResearchSynthesis"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: { summary: "Summary", themes: [], patterns: [], jobs: [], recommendations: [] },
    })).rejects.toBeInstanceOf(RestNotFoundError)

    expect(mocks.getResearchStudy).toHaveBeenCalledWith({ workspaceId: UUID }, expect.objectContaining({ userId: "user-1" }), FOREIGN)
    expect(mocks.storeAgentStudySynthesis).not.toHaveBeenCalled()
  })

  it("does not mint a participant credential when its disclosure URL is unavailable", async () => {
    mocks.researchParticipantUrl.mockImplementation(() => { throw new Error("Compass app URL is not configured.") })

    await expect(executeRestRoute(route("activateResearchStudy"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toThrow("not configured")

    expect(mocks.activateResearchStudy).not.toHaveBeenCalled()
  })

  it("maps typed research cursor failures to invalid-cursor errors", async () => {
    mocks.listResearchStudies.mockRejectedValue(new ResearchCursorError("Invalid research cursor"))

    await expect(executeRestRoute(route("listResearchStudies"), {
      params: { workspaceId: UUID }, query: { cursor: "tampered" }, body: undefined,
    })).rejects.toBeInstanceOf(RestCursorError)
  })

  it.each([
    ["listResearchSessions", "listResearchSessions"],
    ["listResearchSyntheses", "listResearchSyntheses"],
  ] as const)("honors limit=1 and continues the %s collection with a signed cursor", async (operationId, mockName) => {
    const service = mocks[mockName]
    service
      .mockResolvedValueOnce({ items: [{ id: UUID }], nextOffset: 1 })
      .mockResolvedValueOnce({ items: [], nextOffset: null })
    const params = { workspaceId: UUID, id: FOREIGN }

    const first = await executeRestRoute(route(operationId), { params, query: { limit: 1 }, body: undefined }) as { nextCursor: string }
    await expect(executeRestRoute(route(operationId), { params, query: { limit: 2, cursor: first.nextCursor }, body: undefined }))
      .rejects.toBeInstanceOf(RestCursorError)
    await executeRestRoute(route(operationId), { params, query: { limit: 1, cursor: first.nextCursor }, body: undefined })

    expect(service).toHaveBeenNthCalledWith(1, { workspaceId: UUID }, expect.anything(), FOREIGN, expect.objectContaining({ offset: 0, limit: 1 }))
    expect(service).toHaveBeenNthCalledWith(2, { workspaceId: UUID }, expect.anything(), FOREIGN, expect.objectContaining({ offset: 1, limit: 1 }))
  })

  it("honors limit=1 for transcript turns and binds continuation to that limit", async () => {
    mocks.getResearchSession
      .mockResolvedValueOnce({ id: THIRD, turns: [{ id: UUID }], nextOffset: 1 })
      .mockResolvedValueOnce({ id: THIRD, turns: [], nextOffset: null })
    const params = { workspaceId: UUID, id: FOREIGN, relatedId: THIRD }

    const first = await executeRestRoute(route("getResearchSession"), { params, query: { limit: 1 }, body: undefined }) as { nextCursor: string }
    await executeRestRoute(route("getResearchSession"), { params, query: { limit: 1, cursor: first.nextCursor }, body: undefined })

    expect(mocks.getResearchSession).toHaveBeenNthCalledWith(2, { workspaceId: UUID }, expect.anything(), FOREIGN, THIRD, { offset: 1, limit: 1 })
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

  it("pre-fences a document by workspace before calling the shared document service", async () => {
    mocks.prisma.doc.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("getDoc"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.getDoc).not.toHaveBeenCalled()
  })

  it("pre-fences document versions and shared comments through their workspace ancestry", async () => {
    mocks.prisma.docVersion.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("getDocVersion"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.prisma.docVersion.findFirst).toHaveBeenCalledWith({ where: { id: FOREIGN, doc: { workspaceId: UUID } }, select: { id: true } })

    mocks.prisma.comment.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("getComment"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.prisma.comment.findFirst).toHaveBeenCalledWith({ where: { id: FOREIGN, workspaceId: UUID }, select: { id: true, authorId: true, targetType: true } })
  })

  it("normalizes reused service not-found and validation failures", async () => {
    mocks.prisma.doc.findFirst.mockResolvedValue({ id: FOREIGN })
    mocks.getDoc.mockResolvedValue({ content: [{ type: "text", text: "missing" }], structuredContent: { ok: false, message: `Doc "${FOREIGN}" not found.`, data: null } })
    await expect(executeRestRoute(route("getDoc"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined,
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(() => { throw new RestValidationError("invalid") }).toThrow(RestValidationError)
  })

  it("pre-fences a checklist item through checklist and roadmap workspace ancestry", async () => {
    mocks.prisma.launchChecklistItem.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("updateLaunchChecklistItem"), {
      params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: { status: "DONE" },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.prisma.launchChecklistItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: FOREIGN, launchChecklist: { roadmapItem: { workspaceId: UUID } } },
    }))
    expect(mocks.updateLaunchChecklistItem).not.toHaveBeenCalled()
  })

  it("requires workspace administration before preparing release authorization", async () => {
    mocks.assertWorkspaceAdmin.mockRejectedValue(new Error("forbidden"))
    await expect(executeRestRoute(route("requestReleaseAuthorization"), {
      params: { workspaceId: UUID }, query: {}, body: {
        provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 7,
        baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
        releasePolicyId: FOREIGN, taskIds: [THIRD],
      },
    })).rejects.toThrow("forbidden")
    expect(mocks.requestReleaseAuthorization).not.toHaveBeenCalled()
  })

  it("does not let a service identity request a human release authorization", async () => {
    mocks.actor.current = { userId: null, purpose: "SERVICE" }
    await expect(executeRestRoute(route("requestReleaseAuthorization"), {
      params: { workspaceId: UUID }, query: {}, body: {
        provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 7,
        baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
        releasePolicyId: "policy", taskIds: [THIRD],
      },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.assertWorkspaceAdmin).not.toHaveBeenCalled()
    expect(mocks.requestReleaseAuthorization).not.toHaveBeenCalled()
  })

  it("rejects unsigned notification cursors instead of restarting the inbox", async () => {
    await expect(executeRestRoute(route("listNotifications"), {
      params: { workspaceId: UUID }, query: { cursor: "unsigned" }, body: undefined,
    })).rejects.toMatchObject({ message: "The cursor is invalid for this inbox or filter set." })
    expect(mocks.listNotifications).not.toHaveBeenCalled()
  })

  it("fills a notification page after inaccessible rows are filtered", async () => {
    const rawCursor = (minute: number, id: string) => Buffer.from(`${new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()}|${id}`).toString("base64url")
    mocks.listNotifications
      .mockResolvedValueOnce({ items: [], groups: [], nextCursor: rawCursor(2, UUID) })
      .mockResolvedValueOnce({ items: [{ id: FOREIGN, kind: "COMMENT_ADDED", subjectType: "DOC", subjectId: THIRD, actor: { type: "USER", id: null, name: "A teammate" }, payload: {}, read: false, readAt: null, subject: { title: "Plan", path: `docs/${THIRD}` }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1)) }], groups: [], nextCursor: null })
    mocks.unreadCount.mockResolvedValue({ count: 1, overflow: false })
    const result = await executeRestRoute(route("listNotifications"), {
      params: { workspaceId: UUID }, query: { limit: 1 }, body: undefined,
    }) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(result.items).toEqual([expect.objectContaining({ id: FOREIGN, createdAt: "2026-01-01T00:01:00.000Z" })])
    expect(result.nextCursor).toBeNull()
    expect(route("listNotifications").responseSchema.safeParse(result).success).toBe(true)
    expect(mocks.listNotifications).toHaveBeenCalledTimes(2)
  })

  it("binds decision cursors to the requested page size", async () => {
    mocks.listDecisions.mockResolvedValue(success({ requests: [{ id: UUID }], total: 3 }))
    const first = await executeRestRoute(route("listDecisions"), {
      params: { workspaceId: UUID }, query: { limit: 1 }, body: undefined,
    }) as { nextCursor: string }
    expect(first.nextCursor).toBeTruthy()
    await expect(executeRestRoute(route("listDecisions"), {
      params: { workspaceId: UUID }, query: { limit: 2, cursor: first.nextCursor }, body: undefined,
    })).rejects.toMatchObject({ message: "The cursor is invalid for this collection or filter set." })
    expect(mocks.listDecisions).toHaveBeenCalledTimes(1)
  })

  it("routes generic DOC comment mutations through the mirrored legacy services", async () => {
    const comment = { id: FOREIGN, workspaceId: UUID, targetType: "DOC", targetId: THIRD, parentId: null, body: "Body", status: "OPEN", authorId: "user-1", authorName: "User", authorType: "HUMAN", source: "UI", createdAt: new Date(), updatedAt: new Date() }
    mocks.prisma.doc.findUnique.mockResolvedValue({ workspaceId: UUID })
    mocks.prisma.user.findFirst.mockResolvedValue({ name: "User", email: "user@example.com" })
    mocks.createDocCommentCore.mockResolvedValue({ ok: true, comment })
    await executeRestRoute(route("createComment"), { params: { workspaceId: UUID, targetType: "DOC", targetId: THIRD }, query: {}, body: { body: "Body" } })
    expect(mocks.createDocCommentCore).toHaveBeenCalledWith(expect.objectContaining({ docId: THIRD, body: "Body" }))
    expect(mocks.createComment).not.toHaveBeenCalled()

    mocks.prisma.comment.findFirst.mockResolvedValue({ id: FOREIGN, authorId: "user-1", targetType: "DOC" })
    mocks.updateDocComment.mockResolvedValue(success(comment))
    mocks.resolveDocComment.mockResolvedValue(success({ ...comment, status: "RESOLVED" }))
    mocks.reopenDocComment.mockResolvedValue(success(comment))
    mocks.deleteDocComment.mockResolvedValue(success({ id: FOREIGN }))
    await executeRestRoute(route("updateComment"), { params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: { body: "Changed" } })
    await executeRestRoute(route("resolveComment"), { params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined })
    await executeRestRoute(route("reopenComment"), { params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined })
    await executeRestRoute(route("deleteComment"), { params: { workspaceId: UUID, id: FOREIGN }, query: {}, body: undefined })
    expect(mocks.updateDocComment).toHaveBeenCalledWith({ commentId: FOREIGN, body: "Changed" })
    expect(mocks.resolveDocComment).toHaveBeenCalledWith({ commentId: FOREIGN })
    expect(mocks.reopenDocComment).toHaveBeenCalledWith({ commentId: FOREIGN })
    expect(mocks.deleteDocComment).toHaveBeenCalledWith({ commentId: FOREIGN })
    expect(mocks.deleteBrowserComment).not.toHaveBeenCalled()
  })

  it("rejects a generic comment parent outside the exact workspace and target", async () => {
    mocks.prisma.doc.findUnique.mockResolvedValue({ workspaceId: UUID })
    mocks.prisma.comment.findFirst.mockResolvedValue(null)
    await expect(executeRestRoute(route("createComment"), {
      params: { workspaceId: UUID, targetType: "DOC", targetId: THIRD }, query: {}, body: { body: "Reply", parentId: FOREIGN },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.createDocCommentCore).not.toHaveBeenCalled()
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("rejects foreign release tasks before requesting authorization", async () => {
    mocks.assertWorkspaceAdmin.mockResolvedValue(undefined)
    mocks.prisma.task.count.mockResolvedValue(1)
    await expect(executeRestRoute(route("requestReleaseAuthorization"), {
      params: { workspaceId: UUID }, query: {}, body: { provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 7, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION", releasePolicyId: "policy", taskIds: [FOREIGN, THIRD] },
    })).rejects.toBeInstanceOf(RestNotFoundError)
    expect(mocks.requestReleaseAuthorization).not.toHaveBeenCalled()
  })

  it("paginates release runs by updatedAt and id without exposing raw task rows", async () => {
    const row = (id: string, updatedAt: Date) => ({
      id, state: "READY_FOR_APPROVAL", provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app",
      pullRequestNumber: 7, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION",
      releasePolicyId: "policy", sourceFingerprint: "fingerprint", authorizationDecisionRecordId: null,
      lastErrorCode: null, createdAt: updatedAt, updatedAt, tasks: [{ taskId: THIRD }], dispatches: [],
    })
    const firstAt = new Date("2026-10-02T12:00:00.000Z")
    mocks.prisma.releaseRun.findMany
      .mockResolvedValueOnce([row(UUID, firstAt), row(FOREIGN, new Date("2026-10-02T11:00:00.000Z"))])
      .mockResolvedValueOnce([row(FOREIGN, new Date("2026-10-02T11:00:00.000Z"))])
    const first = await executeRestRoute(route("listReleaseRuns"), { params: { workspaceId: UUID }, query: { limit: 1 }, body: undefined }) as { items: Array<Record<string, unknown>>; nextCursor: string }
    expect(first.items[0]).toMatchObject({ id: UUID, taskIds: [THIRD], pullRequestUrl: "https://github.com/acme/app/pull/7" })
    expect(first.items[0]).not.toHaveProperty("tasks")
    expect(route("listReleaseRuns").responseSchema.safeParse(first).success).toBe(true)
    await executeRestRoute(route("listReleaseRuns"), { params: { workspaceId: UUID }, query: { limit: 1, cursor: first.nextCursor }, body: undefined })
    expect(mocks.prisma.releaseRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: UUID, OR: [{ updatedAt: { lt: firstAt } }, { updatedAt: firstAt, id: { lt: UUID } }] }), take: 2 }))
  })
})
