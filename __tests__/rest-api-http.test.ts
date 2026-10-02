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
import { RestBadRequestError, RestForbiddenError, RestNotFoundError } from "@/lib/rest/execute"
import { AnalyticsError } from "@/lib/analytics/providers"
import { DocumentError } from "@/lib/document-service"
import { CommentHttpError } from "@/lib/comment-http-error"

const UUID = "11111111-1111-4111-8111-111111111111"
const UUID_2 = "22222222-2222-4222-8222-222222222222"
const UUID_3 = "33333333-3333-4333-8333-333333333333"
const NOW = "2026-10-02T00:00:00.000Z"

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

  it("denies AGENT_TURN credentials before REST execution", async () => {
    validateProgrammaticAuth.mockResolvedValue({ valid: true, userId: "user-1", agentId: UUID, purpose: "AGENT_TURN", scopeWorkspaceId: UUID, scopes: ["api:write"] })
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Blocked", operationId: UUID }) }), "POST")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "forbidden" })
    expect(executeRestRoute).not.toHaveBeenCalled()
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

  it.each([
    ["POST", `/api/v1/workspaces/${UUID}/docs`, { id: UUID, title: "Plan", url: "https://compass.rbcodelabs.com/acme/ws/docs/plan", revision: "r1", storageProvider: "DATABASE" }, { title: "Plan", operationId: UUID }, "url"],
    ["POST", `/api/v1/workspaces/${UUID}/doc-versions/${UUID}/restore`, { id: UUID, docId: UUID, title: "Plan", restoredFrom: "2026-10-02T00:00:00.000Z", revision: "r2" }, { expectedRevision: "r1", operationId: UUID }, "restoredFrom"],
    ["POST", `/api/v1/workspaces/${UUID}/artifacts`, { id: UUID, title: "Prototype", sourceType: "EXTERNAL_LINK" }, { title: "Prototype", sourceType: "EXTERNAL_LINK", url: "https://example.com" }, "sourceType"],
    ["POST", `/api/v1/workspaces/${UUID}/release-authorizations`, { status: "READY", requestId: UUID, releaseRunId: UUID, revisionId: UUID, sourceFingerprint: "source", reviewFingerprint: "fp", reviewUrl: "https://compass.rbcodelabs.com/reviews/1" }, { provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 1, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION", releasePolicyId: "policy", taskIds: [UUID] }, "releaseRunId"],
  ] as const)("preserves Phase 3 response field %s %s", async (method, path, result, body, field) => {
    executeRestRoute.mockResolvedValueOnce(result)
    const response = await handleRestRequest(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), method)
    expect(response.status).toBe(method === "POST" && path.endsWith("/restore") ? 200 : 201)
    expect(await response.json()).toHaveProperty(field)
  })

  it("preserves notification unread metadata and strict comment fields", async () => {
    executeRestRoute.mockResolvedValueOnce({ items: [], nextCursor: null, unreadCount: 4, unreadOverflow: false })
    const notifications = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/notifications?unreadOnly=false`), "GET")
    expect(await notifications.json()).toMatchObject({ unreadCount: 4, unreadOverflow: false })

    executeRestRoute.mockResolvedValueOnce({ id: UUID, workspaceId: UUID, targetType: "TASK", targetId: UUID, parentId: null, body: "Ready", status: "OPEN", authorId: UUID, authorName: "User", authorType: "HUMAN", source: "UI", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" })
    const comment = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/comments/TASK/${UUID}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Ready" }) }), "POST")
    expect(comment.status).toBe(201)
    expect(await comment.json()).toMatchObject({ targetType: "TASK", body: "Ready" })
  })

  it.each([
    ["POST", `/api/v1/workspaces/${UUID}/follows/DOC/${UUID_2}`, { subjectType: "DOC", subjectId: UUID_2, status: "followed" }, undefined, "status"],
    ["POST", `/api/v1/workspaces/${UUID}/artifacts/${UUID_2}/decisions`, { workspaceId: UUID, artifactId: UUID_2, requestId: UUID_3, linkId: UUID, created: true }, { requestId: UUID_3 }, "artifactId"],
    ["POST", `/api/v1/workspaces/${UUID}/decision-requests`, { id: UUID_2, requestId: UUID_3, revisionNumber: 1, sourceFingerprint: null, fingerprint: "f".repeat(64), title: "Choose", summary: "Context", packetJson: "{}", requiredRole: "ADMIN", expiresAt: null, supersededAt: null, createdAt: NOW, reviewUrl: "https://compass.rbcodelabs.com/reviews/1" }, { subjectType: "DOC", subjectId: UUID_2, question: "Choose?", context: "Context", idempotencyKey: UUID_3 }, "sourceFingerprint"],
    ["GET", `/api/v1/workspaces/${UUID}/decision-requests/${UUID_2}`, { id: UUID_2, workspaceId: UUID, gateType: "TRACKED_DECISION", subjectType: "DOC", subjectId: UUID_3, state: "PENDING", currentRevisionId: UUID, revisionCount: 1, decisionCycle: 1, reopenReason: null, reopenedById: null, reconsidersDecisionId: null, requestedById: UUID, requestedByAgentId: null, assignedToId: null, dueAt: null, expiresAt: null, noActionAt: null, noActionById: null, noActionReason: null, createdAt: NOW, updatedAt: NOW, currentRevision: { id: UUID, requestId: UUID_2, revisionNumber: 1, sourceFingerprint: null, fingerprint: "f".repeat(64), title: "Choose", summary: null, packetJson: "{}", requiredRole: "ADMIN", expiresAt: null, supersededAt: null, createdAt: NOW, options: [], decisions: [] }, revisions: [], artifacts: [], reviewUrl: null, requestedBy: { type: "HUMAN", id: UUID, name: "Alice" }, followUpTasks: [], noAction: null, options: [], chosenOption: null, questions: [], answers: [] }, undefined, "dueAt"],
    ["GET", `/api/v1/workspaces/${UUID}/review-requests/${UUID_2}`, { id: UUID_2, workspaceId: UUID, gateType: "RELEASE_AUTHORIZATION", subjectType: "RELEASE_RUN", subjectId: UUID_3, state: "PENDING", currentRevisionId: UUID, revisionCount: 1, decisionCycle: 1, reopenReason: null, reopenedById: null, reconsidersDecisionId: null, requestedById: UUID, requestedByAgentId: null, assignedToId: null, dueAt: null, expiresAt: null, noActionAt: null, noActionById: null, noActionReason: null, createdAt: NOW, updatedAt: NOW, currentRevision: { id: UUID, requestId: UUID_2, revisionNumber: 1, sourceFingerprint: "s".repeat(64), fingerprint: "f".repeat(64), title: "Release", summary: null, packetJson: "{}", requiredRole: "ADMIN", expiresAt: null, supersededAt: null, createdAt: NOW, options: [], decisions: [] }, artifacts: [], reviewUrl: null, options: [], chosenOption: null, questions: [], answers: [] }, undefined, "currentRevision"],
    ["POST", `/api/v1/workspaces/${UUID}/release-authorizations`, { status: "READY", requestId: UUID, releaseRunId: UUID_2, revisionId: UUID_3, sourceFingerprint: "s".repeat(64), reviewFingerprint: "r".repeat(64), reviewUrl: "https://compass.rbcodelabs.com/reviews/1" }, { provider: "GITHUB", repositoryOwner: "acme", repositoryName: "app", pullRequestNumber: 1, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION", releasePolicyId: "policy", taskIds: [UUID] }, "status"],
    ["GET", `/api/v1/workspaces/${UUID}/docs/${UUID_2}/versions`, { items: [{ id: UUID_3, docId: UUID_2, label: null, createdByName: null, createdAt: NOW }], nextCursor: null }, undefined, "items"],
  ] as const)("accepts the complete shared-handler payload for %s %s", async (method, path, result, body, field) => {
    executeRestRoute.mockResolvedValueOnce(result)
    const response = await handleRestRequest(new Request(`http://localhost${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }), method)
    expect(response.status).toBe(method === "POST" ? 201 : 200)
    expect(await response.json()).toHaveProperty(field)
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

  it.each([
    [new RestForbiddenError("hidden tally"), 403, "forbidden"],
    [new RestBadRequestError("invalid card-sort option"), 400, "invalid_request"],
  ])("maps typed Phase 4 domain failures to RFC 9457", async (error, status, code) => {
    executeRestRoute.mockRejectedValueOnce(error)
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/card-sort-rounds/${UUID}/tally`), "GET")
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toContain("application/problem+json")
    expect(await response.json()).toMatchObject({ status, code })
  })

  it.each([
    ["not-found", 404, "not_found"],
    ["parent-not-found", 404, "not_found"],
    ["revision-conflict", 409, "conflict"],
    ["operation-conflict", 409, "conflict"],
    ["has-children", 409, "conflict"],
    ["operation-id-required", 422, "validation_failed"],
    ["revision-required", 422, "validation_failed"],
    ["invalid-canvas", 422, "validation_failed"],
  ])("maps DocumentError %s to RFC 9457 status %s", async (code, status, problemCode) => {
    executeRestRoute.mockRejectedValueOnce(new DocumentError(code))
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/docs/${UUID}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: UUID, expectedRevision: "r1" }) }), "PATCH")
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toContain("application/problem+json")
    expect(await response.json()).toMatchObject({ code: problemCode, status })
  })

  it.each([[404, "not_found"], [409, "conflict"]])("maps CommentHttpError %s without leaking internal detail", async (status, problemCode) => {
    executeRestRoute.mockRejectedValueOnce(new CommentHttpError(status, "private thread detail"))
    const response = await handleRestRequest(new Request(`http://localhost/api/v1/workspaces/${UUID}/comments/${UUID}`, { method: "DELETE" }), "DELETE")
    expect(response.status).toBe(status)
    const body = await response.json() as { code: string; detail: string }
    expect(body.code).toBe(problemCode)
    expect(body.detail).not.toContain("private thread detail")
  })
})
