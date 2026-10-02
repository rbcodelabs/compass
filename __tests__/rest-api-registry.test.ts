import { describe, expect, it } from "vitest"
import { REST_ROUTES, matchRestRoute } from "@/lib/rest/registry"
import { buildOpenApiDocument } from "@/lib/rest/openapi"
import { roadmapCreateData } from "@/lib/roadmap-tool-handlers"

describe("REST API registry", () => {
  it("defines every route with a unique operation id, scope, policy and schemas", () => {
    const operationIds = REST_ROUTES.map((route) => route.operationId)
    expect(new Set(operationIds).size).toBe(operationIds.length)
    for (const route of REST_ROUTES) {
      expect(route.path).toMatch(/^\/api\/v1\//)
      expect(["api:read", "api:write"]).toContain(route.scope)
      expect(route.authorizationPolicy.length).toBeGreaterThan(0)
      expect(route.pathSchema).toBeDefined()
      expect(route.responseSchema).toBeDefined()
    }
  })

  it("covers the approved PR 1 resources", () => {
    const paths = new Set(REST_ROUTES.map((route) => route.path))
    for (const resource of ["opportunities", "solutions", "assumptions", "feedback", "tasks", "roadmap-items"]) {
      expect([...paths].some((path) => path.includes(`/${resource}`))).toBe(true)
    }
    expect(paths.has("/api/v1/me")).toBe(true)
    expect(paths.has("/api/v1/workspaces")).toBe(true)
  })

  it("covers the approved Phase 2 learning and configuration resources", () => {
    const paths = new Set(REST_ROUTES.map((route) => route.path))
    for (const resource of [
      "okr-cycles", "objectives", "key-results", "check-ins", "experiments",
      "results", "metrics", "metric-bindings", "metric-observations",
      "scoring-models", "opportunity-scores", "solution-scores", "squads",
      "custom-field-definitions", "custom-field-values", "entity-links",
    ]) {
      expect([...paths].some((path) => path.includes(`/${resource}`)), `missing ${resource}`).toBe(true)
    }
  })

  it("covers the approved Phase 3 collaboration, documents and governance resources", () => {
    const operations = new Set(REST_ROUTES.map((route) => route.operationId))
    for (const operationId of [
      "listComments", "createComment", "getComment", "updateComment", "deleteComment", "resolveComment", "reopenComment",
      "followResource", "unfollowResource", "listNotifications", "markNotificationsRead",
      "listDocs", "getDoc", "createDoc", "updateDoc", "prepareDocImageUpload",
      "listDocVersions", "createDocVersion", "getDocVersion", "restoreDocVersion",
      "listDocComments", "createDocComment", "getDocComment", "updateDocComment", "deleteDocComment", "resolveDocComment", "reopenDocComment",
      "listArtifacts", "getArtifact", "createArtifact", "updateArtifact", "archiveArtifact",
      "linkArtifactSolution", "unlinkArtifactSolution", "linkArtifactDecision", "unlinkArtifactDecision",
      "requestDecision", "listDecisions", "getDecision", "listReviewRequests", "getReviewRequest",
      "listSolutionPlanEntries", "getSolutionPlanEntry", "createSolutionPlan", "createSolutionPlanComment", "updateSolutionPlanEntry", "deleteSolutionPlanEntry",
      "setLaunchTier", "getLaunchChecklist", "updateLaunchChecklistItem",
      "requestReleaseAuthorization", "listReleaseRuns",
    ]) expect(operations.has(operationId), operationId).toBe(true)
  })

  it("does not expose human decisions, plan approval, decision application or release dispatch", () => {
    const operations = new Set(REST_ROUTES.map((route) => route.operationId))
    for (const operationId of ["recordDecision", "closeDecisionNoAction", "applyRecordedDecision", "approveSolutionPlan", "rejectSolutionPlan", "dispatchRelease"]) {
      expect(operations.has(operationId), operationId).toBe(false)
    }
  })

  it("keeps one-time credentials and authorization requests write-scoped", () => {
    for (const operationId of ["prepareDocImageUpload", "requestReleaseAuthorization"]) {
      expect(REST_ROUTES.find((route) => route.operationId === operationId)).toMatchObject({ method: "POST", scope: "api:write" })
    }
  })

  it("documents custom-field collections in configured display order", () => {
    expect(REST_ROUTES.find((route) => route.operationId === "listCustomFieldDefinitions")?.summary).toContain("configured display order")
    expect(REST_ROUTES.find((route) => route.operationId === "listCustomFieldValues")?.summary).toContain("configured display order")
  })

  it("requires optimistic concurrency tokens on experiment and metric updates", () => {
    const experiment = REST_ROUTES.find((route) => route.operationId === "updateExperiment")!
    expect(experiment.bodySchema?.safeParse({ title: "Changed" }).success).toBe(false)
    expect(experiment.bodySchema?.safeParse({ expectedUpdatedAt: "2026-10-02T12:00:00.000Z", title: "Changed" }).success).toBe(true)

    const metric = REST_ROUTES.find((route) => route.operationId === "updateMetric")!
    expect(metric.bodySchema?.safeParse({ name: "Activation" }).success).toBe(false)
    expect(metric.bodySchema?.safeParse({
      expectedRevision: 1, name: "Activation", unit: "teams", provider: "vercel",
      connectionId: "11111111-1111-4111-8111-111111111111", query: { metric: "pageviews" },
    }).success).toBe(true)

    const conclusion = REST_ROUTES.find((route) => route.operationId === "concludeExperiment")!
    expect(conclusion.bodySchema?.safeParse({ conclusion: "PROCEED" }).success).toBe(false)
    expect(conclusion.bodySchema?.safeParse({ conclusion: "PROCEED", expectedUpdatedAt: "2026-10-02T12:00:00.000Z" }).success).toBe(true)
  })

  it("does not accept a scoring formula change without replacement metrics", () => {
    const route = REST_ROUTES.find((entry) => entry.operationId === "updateScoringModel")!
    expect(route.bodySchema?.safeParse({ formulaType: "MULTIPLICATIVE" }).success).toBe(false)
    expect(route.bodySchema?.safeParse({
      formulaType: "MULTIPLICATIVE",
      metrics: [{ key: "reach", label: "Reach", minValue: 1, maxValue: 10, weight: 1, direction: "POSITIVE" }],
    }).success).toBe(true)
  })

  it("reuses strict analytics request contracts", () => {
    const createMetric = REST_ROUTES.find((entry) => entry.operationId === "createMetric")!
    expect(createMetric.bodySchema?.safeParse({ name: "Views", unit: "views", provider: "vercel", query: {} }).success).toBe(false)
    expect(createMetric.bodySchema?.safeParse({ name: "Views", unit: "views", provider: "vercel", query: { metric: "pageviews" } }).success).toBe(true)
    const updateBinding = REST_ROUTES.find((entry) => entry.operationId === "updateMetricBinding")!
    expect(updateBinding.bodySchema?.safeParse({}).success).toBe(false)
    expect(updateBinding.bodySchema?.safeParse({ baseline: { since: "not-a-date", until: "2026-10-02" } }).success).toBe(false)
    expect(updateBinding.bodySchema?.safeParse({ followup: { version: 1, mode: "rolling", days: 30 } }).success).toBe(true)
  })

  it("uses cursor collection envelopes for every Phase 2 list", () => {
    for (const operationId of [
      "listOkrCycles", "listObjectives", "listKeyResults", "listCheckIns",
      "listExperiments", "listExperimentResults", "listMetrics", "listMetricBindings",
      "listMetricObservations", "listScoringModels", "listSquads",
      "listCustomFieldDefinitions", "listCustomFieldValues", "listEntityLinks",
    ]) {
      const route = REST_ROUTES.find((entry) => entry.operationId === operationId)!
      expect(route.querySchema).toBeDefined()
      expect(route.responseSchema.safeParse({ items: [], nextCursor: null }).success, operationId).toBe(true)
      expect(route.responseSchema.safeParse([]).success, operationId).toBe(false)
    }
  })

  it("publishes scoring and binding patch invariants in OpenAPI", () => {
    const document = buildOpenApiDocument()
    const scoringOperation = document.paths["/api/v1/workspaces/{workspaceId}/scoring-models/{id}"].patch as unknown as {
      requestBody: { content: { "application/json": { schema: unknown } } }
    }
    const scoring = scoringOperation.requestBody.content["application/json"].schema as {
      anyOf: Array<{ properties?: Record<string, unknown>; required?: string[] }>
    }
    expect(scoring.anyOf.length).toBeGreaterThan(1)
    for (const branch of scoring.anyOf.filter((candidate) => candidate.properties?.formulaType)) {
      expect(branch.required).toEqual(expect.arrayContaining(["formulaType", "metrics"]))
    }

    const bindingOperation = document.paths["/api/v1/workspaces/{workspaceId}/metric-bindings/{id}"].patch as unknown as {
      requestBody: { content: { "application/json": { schema: unknown } } }
    }
    const binding = bindingOperation.requestBody.content["application/json"].schema as {
      anyOf: Array<{ required?: string[] }>
    }
    expect(binding.anyOf).toHaveLength(3)
    expect(binding.anyOf.every((branch) => (branch.required?.length ?? 0) >= 1)).toBe(true)
  })

  it("publishes valid ISO dates and bounded ordered analytics windows in OpenAPI", () => {
    const document = buildOpenApiDocument()
    const operation = document.paths["/api/v1/workspaces/{workspaceId}/metric-bindings/{id}"].patch as unknown as {
      requestBody: { content: { "application/json": { schema: unknown } } }
    }
    const binding = operation.requestBody.content["application/json"].schema
    const published = JSON.stringify(binding)
    expect(published).toContain('"format":"date"')
    expect(published).toContain("since must be on or before until")
    expect(published).toContain("1 to 90 inclusive calendar days")
  })

  it("matches concrete paths and extracts parameters", () => {
    const matched = matchRestRoute("GET", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/opportunities")
    expect(matched?.route.operationId).toBe("listOpportunities")
    expect(matched?.params.workspaceId).toBe("11111111-1111-4111-8111-111111111111")
    expect(matchRestRoute("PUT", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/opportunities")).toBeNull()
  })

  it("rejects mixed lifecycle mutations so a PATCH cannot partially commit", () => {
    const opportunity = REST_ROUTES.find((route) => route.operationId === "updateOpportunity")!
    expect(opportunity.bodySchema?.safeParse({ title: "Changed", status: "ACTIVE" }).success).toBe(false)
    expect(opportunity.bodySchema?.safeParse({ title: "Changed", description: "Together" }).success).toBe(true)

    const feedback = REST_ROUTES.find((route) => route.operationId === "updateFeedback")!
    expect(feedback.bodySchema?.safeParse({ title: "Changed", opportunityId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false)
  })

  it("publishes lifecycle PATCH alternatives as JSON Schema unions", () => {
    const document = buildOpenApiDocument()
    const operation = document.paths["/api/v1/workspaces/{workspaceId}/opportunities/{id}"].patch as unknown as {
      requestBody: { content: { "application/json": { schema: { anyOf?: unknown[]; oneOf?: unknown[] } } } }
    }
    const schema = operation.requestBody.content["application/json"].schema
    expect(schema.anyOf ?? schema.oneOf).toHaveLength(3)
    const route = REST_ROUTES.find((entry) => entry.operationId === "updateOpportunity")!
    expect(route.bodySchema?.safeParse({}).success).toBe(true)
    expect(route.bodySchema?.safeParse({ title: "Changed", status: "ACTIVE" }).success).toBe(false)
  })

  it("registers roadmap creation as a write-scoped workspace policy", () => {
    const create = REST_ROUTES.find((route) => route.operationId === "createRoadmapItem")
    expect(create).toMatchObject({ method: "POST", scope: "api:write", authorizationPolicy: "workspace-writer", status: 201 })
  })

  it("persists roadmap provenance for MCP and REST creation", () => {
    const base = { workspaceId: "11111111-1111-4111-8111-111111111111", title: "Ship", horizon: "NOW" as const }
    expect(roadmapCreateData(base, 0).source).toBe("MCP")
    expect(roadmapCreateData({ ...base, source: "API" }, 0).source).toBe("API")
  })

  it("generates one OpenAPI operation for every registry route", () => {
    const document = buildOpenApiDocument()
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path))
    expect(operations).toHaveLength(REST_ROUTES.length)
    expect(new Set(operations.map((operation) => operation.operationId))).toEqual(
      new Set(REST_ROUTES.map((route) => route.operationId)),
    )
  })
})
