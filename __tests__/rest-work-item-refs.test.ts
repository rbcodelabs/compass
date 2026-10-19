import { beforeEach, describe, expect, it, vi } from "vitest"

const { assertWorkspaceMember, findFirst } = vi.hoisted(() => ({ assertWorkspaceMember: vi.fn(), findFirst: vi.fn() }))
vi.mock("@/lib/mcp-authz", () => ({ assertWorkspaceMember, McpAuthzError: class extends Error {} }))
vi.mock("@/lib/db", () => ({ default: () => ({ task: { findFirst }, opportunity: { findFirst }, solution: { findFirst } }) }))
vi.mock("@/lib/rest/execute", () => ({
  RestNotFoundError: class RestNotFoundError extends Error {},
  RestBadRequestError: class RestBadRequestError extends Error {},
}))

import { pathIdType, resolveRestRefs } from "@/lib/rest/work-item-refs"
import { REST_ROUTES } from "@/lib/rest/registry"

const WS = "11111111-1111-4111-8111-111111111111"
const UUID = "22222222-2222-4222-8222-222222222222"
const actor = { userId: "u1" } as never
const route = (path: string) => ({ path }) as never

beforeEach(() => vi.resetAllMocks())

describe("pathIdType", () => {
  it("maps work item collections, and nothing else, to their type", () => {
    expect(pathIdType("/api/v1/workspaces/{workspaceId}/tasks/{id}")).toBe("task")
    expect(pathIdType("/api/v1/workspaces/{workspaceId}/key-results/{id}/check-ins")).toBe("keyResult")
    expect(pathIdType("/api/v1/workspaces/{workspaceId}/roadmap-items/{id}")).toBe("roadmapItem")
    expect(pathIdType("/api/v1/workspaces/{workspaceId}/squads/{id}")).toBeNull()
    expect(pathIdType("/api/v1/workspaces/{workspaceId}/tasks")).toBeNull()
  })

  it("never maps a registered collection to the wrong type: every {id} route under a numbered collection resolves", () => {
    const numbered = ["tasks", "opportunities", "solutions", "assumptions", "experiments", "objectives", "key-results", "roadmap-items", "feedback", "docs", "artifacts", "research-studies", "review-requests"]
    for (const r of REST_ROUTES) {
      const segments = r.path.split("/")
      const i = segments.indexOf("{id}")
      if (i > 0 && numbered.includes(segments[i - 1])) expect(pathIdType(r.path), r.path).not.toBeNull()
    }
  })
})

describe("resolveRestRefs", () => {
  it("returns the same object when no display ID is present", async () => {
    const input = { params: { workspaceId: WS, id: UUID }, query: {}, body: { opportunityId: UUID } }
    expect(await resolveRestRefs(route("/api/v1/workspaces/{workspaceId}/tasks/{id}"), input, actor)).toBe(input)
    expect(assertWorkspaceMember).not.toHaveBeenCalled()
  })

  it("resolves the path id, body references and query references inside the path's workspace", async () => {
    findFirst.mockImplementation(async ({ where }: { where: { seqPrefix: string } }) => ({ id: where.seqPrefix === "TASK" ? UUID : "33333333-3333-4333-8333-333333333333", seqPrefix: where.seqPrefix, seqNumber: 1 }))
    const result = await resolveRestRefs(
      route("/api/v1/workspaces/{workspaceId}/tasks/{id}"),
      { params: { workspaceId: WS, id: "task-1" }, query: { opportunityId: "OPP-1" }, body: { solutionId: "SOL-1", title: "keep" } },
      actor,
    )
    expect(result.params).toEqual({ workspaceId: WS, id: UUID })
    expect(result.query).toEqual({ opportunityId: "33333333-3333-4333-8333-333333333333" })
    expect(result.body).toEqual({ solutionId: "33333333-3333-4333-8333-333333333333", title: "keep" })
    expect(assertWorkspaceMember).toHaveBeenCalledWith(expect.anything(), WS)
    expect(assertWorkspaceMember.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0])
  })

  it("is a plain not-found, with no lookup, when the caller cannot use the workspace or the row is missing", async () => {
    assertWorkspaceMember.mockRejectedValue(new Error("denied"))
    await expect(resolveRestRefs(route("/api/v1/workspaces/{workspaceId}/tasks/{id}"), { params: { workspaceId: WS, id: "TASK-1" }, query: {}, body: undefined }, actor)).rejects.toThrow("denied")
    expect(findFirst).not.toHaveBeenCalled()
    assertWorkspaceMember.mockResolvedValue(undefined)
    findFirst.mockResolvedValue(null)
    await expect(resolveRestRefs(route("/api/v1/workspaces/{workspaceId}/tasks/{id}"), { params: { workspaceId: WS, id: "TASK-1" }, query: {}, body: undefined }, actor)).rejects.toMatchObject({ name: "Error" })
  })

  it("rejects a display ID of another type with its real type named", async () => {
    await expect(resolveRestRefs(route("/api/v1/workspaces/{workspaceId}/tasks/{id}"), { params: { workspaceId: WS, id: "OPP-1" }, query: {}, body: undefined }, actor)).rejects.toThrow("OPP-1 is a Opportunity")
  })

  it("does not apply display IDs to routes outside a workspace", async () => {
    await expect(resolveRestRefs(route("/api/v1/organizations/{orgSlug}/tasks/{id}"), { params: { orgSlug: "acme", id: "TASK-1" }, query: {}, body: undefined }, actor)).rejects.toBeDefined()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
