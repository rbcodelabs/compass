import { describe, expect, it } from "vitest"
import { REST_ROUTES, matchRestRoute } from "@/lib/rest/registry"
import { buildOpenApiDocument } from "@/lib/rest/openapi"
import { roadmapCreateData } from "@/lib/roadmap-tool-handlers"

const UUID = "11111111-1111-4111-8111-111111111111"

describe("REST API registry", () => {
  it("enumerates the complete authorized Phase 4 route and method surface", () => {
    const expected = [
      ["GET", "/api/v1/workspaces/{workspaceId}/research-studies"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies"],
      ["GET", "/api/v1/workspaces/{workspaceId}/research-studies/{id}"], ["PATCH", "/api/v1/workspaces/{workspaceId}/research-studies/{id}"],
      ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/activation"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/closure"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/archival"],
      ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-links"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-link-rotations"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/participant-link-revocations"],
      ["GET", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/sessions"], ["GET", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/sessions/{relatedId}"],
      ["GET", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/syntheses"], ["POST", "/api/v1/workspaces/{workspaceId}/research-studies/{id}/syntheses"],
      ["POST", "/api/v1/workspaces/{workspaceId}/research-syntheses/{id}/evidence-promotions"],
      ["GET", "/api/v1/workspaces/{workspaceId}/pm-interviews/{id}"],
      ["GET", "/api/v1/workspaces/{workspaceId}/analytics-connections"], ["POST", "/api/v1/workspaces/{workspaceId}/analytics-connections"], ["DELETE", "/api/v1/workspaces/{workspaceId}/analytics-connections/{id}"],
      ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-factors"],
      ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-rounds"], ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds"],
      ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/reveal"], ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/closure"],
      ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/board"], ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/proposals"], ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/proposals"],
      ["DELETE", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/proposals/{relatedId}"], ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/tally"],
      ["GET", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries"], ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries"], ["DELETE", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}"],
      ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}/acceptance"], ["POST", "/api/v1/workspaces/{workspaceId}/card-sort-rounds/{id}/new-entries/{relatedId}/rejection"],
    ]
    const actual = REST_ROUTES.filter(route => /research|pm-interview|analytics-connection|card-sort/.test(route.path)).map(route => [route.method, route.path])
    expect(actual).toEqual(expected)
  })

  it("keeps Phase 4 private protocols and fields out of the contract", () => {
    const serialized = JSON.stringify(buildOpenApiDocument())
    for (const field of ["shareTokenHash", "tokenHash", "resumeTokenHash", "participantTokenId", "participantName", "participantEmail", "audioUrl", "secretEncrypted", "leaseId", "prompt"]) {
      expect(serialized).not.toContain(`\"${field}\"`)
    }
    const phase4Paths = REST_ROUTES.filter(route => /research|pm-interview|analytics-connection|card-sort/.test(route.path))
    expect(phase4Paths.some(route => /voice|respond|complete|attachment|unreveal/.test(route.path))).toBe(false)
    expect(REST_ROUTES.some(route => route.path.includes("pm-interviews") && route.method !== "GET")).toBe(false)
    for (const fragment of ["research-guides", "/voice", "/attachments", "/respond", "/unreveal"]) {
      expect(phase4Paths.some(route => route.path.includes(fragment)), fragment).toBe(false)
    }
  })

  it("uses strict privacy-minimal Phase 4 response DTOs", () => {
    const response = (operationId: string) => REST_ROUTES.find(route => route.operationId === operationId)!.responseSchema
    const synthesis = { summary: "Summary", themes: [], patterns: [], jobs: [], recommendations: [] }
    expect(response("createResearchSynthesis").safeParse(synthesis).success).toBe(true)
    for (const privateField of ["sourceFingerprint", "guideFingerprint", "model", "promptVersion", "claimId", "leaseId"]) {
      expect(response("createResearchSynthesis").safeParse({ ...synthesis, [privateField]: "private" }).success, privateField).toBe(false)
    }
    const connection = { id: UUID, provider: "vercel", projectId: "project", teamId: null, enabled: true, health: "CONNECTED", generation: 1 }
    expect(response("saveAnalyticsConnection").safeParse(connection).success).toBe(true)
    expect(response("saveAnalyticsConnection").safeParse({ ...connection, secretEncrypted: "ciphertext" }).success).toBe(false)
    const session = { id: UUID, studyId: UUID, modality: "CHAT", status: "COMPLETED", startedAt: null, completedAt: null, lastActiveAt: null, endedReason: null, createdAt: "2026-10-02T00:00:00.000Z", turnCount: 1, hasSummary: true }
    expect(response("listResearchSessions").safeParse({ items: [session], nextCursor: null }).success).toBe(true)
    for (const privateField of ["participantName", "participantEmail", "resumeTokenHash", "audioUrl", "participantTokenId"]) {
      expect(response("listResearchSessions").safeParse({ items: [{ ...session, [privateField]: "private" }], nextCursor: null }).success, privateField).toBe(false)
    }
  })

  it("requires human callers for participant links and card-sort mutations and admins for analytics secrets", () => {
    for (const operationId of ["activateResearchStudy", "issueResearchParticipantLink", "rotateResearchParticipantLink", "revokeResearchParticipantLinks", "createCardSortRound", "revealCardSortRound", "proposeCardSortMoves", "acceptCardSortNewEntry"]) {
      expect(REST_ROUTES.find(route => route.operationId === operationId)?.authorizationPolicy, operationId).toBe("human-member")
    }
    for (const operationId of ["saveAnalyticsConnection", "disconnectAnalyticsConnection"]) {
      expect(REST_ROUTES.find(route => route.operationId === operationId)?.authorizationPolicy, operationId).toBe("human-admin")
    }
  })

  it("creates studies as drafts and reserves credential disclosure for explicit actions", () => {
    const create = REST_ROUTES.find(route => route.operationId === "createResearchStudy")!
    expect(create.bodySchema?.safeParse({ name: "Study", goal: "Learn", guide: ["Question"], status: "ACTIVE" }).success).toBe(false)
    expect(create.summary).toContain("without issuing participant credentials")
    for (const operationId of ["activateResearchStudy", "issueResearchParticipantLink", "rotateResearchParticipantLink"]) {
      expect(REST_ROUTES.find(route => route.operationId === operationId)?.responseSchema.safeParse({ id: UUID, participantUrl: "https://compass.example/research/one-time" }).success).toBe(true)
    }
  })
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
    for (const [method, path] of [
      ["POST", `/api/v1/workspaces/${UUID}/decision-requests/${UUID}/decision`],
      ["POST", `/api/v1/workspaces/${UUID}/decision-requests/${UUID}/apply`],
      ["POST", `/api/v1/workspaces/${UUID}/solution-plan-entries/${UUID}/approval`],
      ["POST", `/api/v1/workspaces/${UUID}/release-runs/${UUID}/dispatch`],
    ]) expect(matchRestRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it("keeps one-time credentials and authorization requests write-scoped", () => {
    for (const operationId of ["prepareDocImageUpload", "requestReleaseAuthorization"]) {
      expect(REST_ROUTES.find((route) => route.operationId === operationId)).toMatchObject({ method: "POST", scope: "api:write" })
    }
    const release = REST_ROUTES.find((route) => route.operationId === "requestReleaseAuthorization")!
    expect(release.bodySchema?.safeParse({ provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 1, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION", releasePolicyId: "policy", taskIds: ["11111111-1111-4111-8111-111111111111"] }).success).toBe(true)
    expect(release.bodySchema?.safeParse({ provider: "GITHUB", repoOwner: "acme", repoName: "app", pullRequestNumber: 1, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION", releasePolicyId: "policy", taskIds: ["11111111-1111-4111-8111-111111111111"] }).success).toBe(false)
    const upload = REST_ROUTES.find((route) => route.operationId === "prepareDocImageUpload")!
    expect(upload.responseSchema.safeParse({ imageId: "11111111-1111-4111-8111-111111111111", imageName: "image.png", pathname: "docs/ws/images/image.png", url: "/api/docs/images/ws/image.png", filename: "image.png", fileType: "image/png", fileSize: 123, clientToken: "token", expiresAt: Date.now(), access: "private", markdown: "![image](/api/docs/images/ws/image.png)" }).success).toBe(true)
  })

  it("uses the shared launch-checklist status vocabulary", () => {
    const route = REST_ROUTES.find((entry) => entry.operationId === "updateLaunchChecklistItem")!
    expect(route.bodySchema?.safeParse({ status: "DONE" }).success).toBe(true)
    expect(route.bodySchema?.safeParse({ checked: true }).success).toBe(false)
    const tier = REST_ROUTES.find((entry) => entry.operationId === "setLaunchTier")!
    expect(tier.bodySchema?.safeParse({ tier: "TIER_1" }).success).toBe(true)
    expect(tier.bodySchema?.safeParse({ tier: "LIGHT" }).success).toBe(false)
  })

  it("parses URL booleans strictly instead of treating false as truthy", () => {
    for (const [operationId, key] of [["listNotifications", "unreadOnly"], ["listArtifacts", "includeArchived"]] as const) {
      const schema = REST_ROUTES.find((route) => route.operationId === operationId)!.querySchema!
      expect(schema.parse({ [key]: "true" })).toMatchObject({ [key]: true })
      expect(schema.parse({ [key]: "false" })).toMatchObject({ [key]: false })
      expect(schema.safeParse({ [key]: "1" }).success).toBe(false)
      expect(schema.safeParse({ [key]: "yes" }).success).toBe(false)
    }
  })

  it("publishes required Phase 3 response contracts without stripping legitimate fields", () => {
    const parse = (operationId: string, value: unknown) => REST_ROUTES.find((route) => route.operationId === operationId)!.responseSchema.parse(value)
    expect(parse("createDoc", { id: UUID, title: "Plan", url: "https://compass.example/acme/ws/docs/1", revision: "r1", storageProvider: "DATABASE" })).toHaveProperty("url")
    expect(parse("restoreDocVersion", { id: UUID, title: "Plan", restoredFrom: "2026-10-02T00:00:00.000Z", revision: "r2" })).toHaveProperty("restoredFrom")
    expect(parse("listNotifications", { items: [], nextCursor: null, unreadCount: 3, unreadOverflow: false })).toMatchObject({ unreadCount: 3, unreadOverflow: false })
    expect(REST_ROUTES.find((route) => route.operationId === "createComment")!.responseSchema.safeParse({}).success).toBe(false)
    expect(REST_ROUTES.find((route) => route.operationId === "createArtifact")!.responseSchema.safeParse({}).success).toBe(false)
    expect(REST_ROUTES.find((route) => route.operationId === "requestReleaseAuthorization")!.responseSchema.safeParse({}).success).toBe(false)

    const openapi = JSON.stringify(buildOpenApiDocument())
    expect(openapi).toContain('"required":["id","title"')
    expect(openapi).toContain('"unreadCount"')
    expect(openapi).toContain('"restoredFrom"')
  })

  it("requires document operation tokens consistently at the public REST boundary", () => {
    const create = REST_ROUTES.find((route) => route.operationId === "createDoc")!
    expect(create.bodySchema?.safeParse({ title: "Plan" }).success).toBe(false)
    expect(create.bodySchema?.safeParse({ title: "Plan", operationId: UUID }).success).toBe(true)
    for (const operationId of ["updateDoc", "createDocVersion", "restoreDocVersion"]) {
      const schema = REST_ROUTES.find((route) => route.operationId === operationId)!.bodySchema!
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ operationId: UUID, expectedRevision: "r1" }).success).toBe(true)
    }
  })

  it("does not advertise threaded solution-plan comments when execution is top-level", () => {
    const route = REST_ROUTES.find((entry) => entry.operationId === "createSolutionPlanComment")!
    expect(route.bodySchema?.safeParse({ body: "A concern" }).success).toBe(true)
    expect(route.bodySchema?.safeParse({ body: "A concern", parentId: UUID }).success).toBe(false)
    expect(route.summary).toContain("top-level")
  })

  it("advertises only follow subjects active in shipped slice 2", () => {
    const schema = REST_ROUTES.find((route) => route.operationId === "followResource")!.pathSchema
    for (const subjectType of ["OPPORTUNITY", "SOLUTION", "TASK", "DOC"]) expect(schema.safeParse({ workspaceId: UUID, subjectType, subjectId: UUID }).success).toBe(true)
    for (const subjectType of ["ARTIFACT", "ASSUMPTION", "EXPERIMENT", "REVIEW_REQUEST"]) expect(schema.safeParse({ workspaceId: UUID, subjectType, subjectId: UUID }).success).toBe(false)
  })

  it("caps page-number decision pagination at the shared service maximum", () => {
    const schema = REST_ROUTES.find((route) => route.operationId === "listDecisions")!.querySchema!
    expect(schema.parse({ limit: "50" })).toMatchObject({ limit: 50 })
    expect(schema.safeParse({ limit: "100" }).success).toBe(false)
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
