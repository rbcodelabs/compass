import { beforeEach, describe, expect, it, vi } from "vitest"

const { validateProgrammaticAuth, executeRestRoute } = vi.hoisted(() => ({
  validateProgrammaticAuth: vi.fn(),
  executeRestRoute: vi.fn(),
}))

vi.mock("@/lib/programmatic-auth", () => ({ validateProgrammaticAuth }))
vi.mock("@/lib/rest/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rest/execute")>()
  return { ...actual, executeRestRoute }
})

import { handleRestRequest } from "@/lib/rest/http"
import { McpAuthzError } from "@/lib/mcp-authz"
import { RestNotFoundError } from "@/lib/rest/execute"
import { AnalyticsError } from "@/lib/analytics/providers"

const UUID = "11111111-1111-4111-8111-111111111111"

describe("REST HTTP adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateProgrammaticAuth.mockResolvedValue({ valid: true, userId: "user-1", purpose: "USER", scopeWorkspaceId: null })
    executeRestRoute.mockResolvedValue({ id: UUID, workspaceId: UUID, title: "Interview customers", description: null, customerSegment: null, status: "EXPLORING", squadId: null, linkedKeyResultId: null, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" })
  })

  it("returns a bearer challenge instead of redirecting when unauthenticated", async () => {
    validateProgrammaticAuth.mockResolvedValue({ valid: false })
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities`), "GET")
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/problem+json")
    expect(response.headers.get("www-authenticate")).toContain("api:read")
  })

  it("rejects an OAuth token with the wrong scope family", async () => {
    validateProgrammaticAuth.mockResolvedValue({ valid: true, userId: "user-1", purpose: "USER", scopeWorkspaceId: null, scopes: ["mcp:write"] })
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities`), "GET")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "insufficient_scope" })
  })

  it("returns 422 with sanitized issues for invalid input", async () => {
    const response = await handleRestRequest(new Request("http://localhost/api/v1/workspaces/not-a-uuid/opportunities"), "GET")
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: "validation_failed", issues: expect.any(Array) })
    expect(executeRestRoute).not.toHaveBeenCalled()
  })

  it("returns resources directly and disables caching", async () => {
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities/${UUID}`), "GET")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ id: UUID, title: "Interview customers" })
  })

  it("returns 400 for malformed JSON", async () => {
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), "POST")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "malformed_json" })
  })

  it("returns Problem Details for malformed path encoding", async () => {
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities/%E0%A4%A`), "GET")
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/problem+json")
    expect(await response.json()).toMatchObject({ code: "malformed_path" })
  })

  it("makes absent and inaccessible resources byte-equivalent", async () => {
    executeRestRoute.mockRejectedValueOnce(new RestNotFoundError())
    const absent = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities/${UUID}`), "GET")
    executeRestRoute.mockRejectedValueOnce(new McpAuthzError("secret tenant detail"))
    const inaccessible = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/opportunities/${UUID}`), "GET")
    expect(inaccessible.status).toBe(404)
    expect(await inaccessible.text()).toBe(await absent.text())
    expect(inaccessible.headers.get("cache-control")).toBe("no-store")
  })

  it("normalizes analytics access denial as the same opaque 404", async () => {
    executeRestRoute.mockRejectedValueOnce(new AnalyticsError("NOT_FOUND_OR_ACCESS_DENIED"))
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/metrics/${UUID}`), "GET")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "not_found" })
  })
})
