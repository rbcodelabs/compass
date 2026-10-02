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
