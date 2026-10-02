import { describe, expect, it } from "vitest"
import { REST_ROUTES, matchRestRoute } from "@/lib/rest/registry"
import { buildOpenApiDocument } from "@/lib/rest/openapi"

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

  it("generates one OpenAPI operation for every registry route", () => {
    const document = buildOpenApiDocument()
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path))
    expect(operations).toHaveLength(REST_ROUTES.length)
    expect(new Set(operations.map((operation) => operation.operationId))).toEqual(
      new Set(REST_ROUTES.map((route) => route.operationId)),
    )
  })
})
