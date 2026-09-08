import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }))
vi.mock("@/lib/workspace-search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace-search")>("@/lib/workspace-search")
  return { ...actual, searchWorkspace: vi.fn() }
})

import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { searchWorkspace } from "@/lib/workspace-search"
import { GET } from "@/app/api/workspace-search/route"

const request = (query = "?orgSlug=acme&workspaceSlug=product&q=plan") =>
  GET(new Request(`http://localhost/api/workspace-search${query}`))

describe("GET /api/workspace-search", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 before workspace lookup when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const response = await request()
    expect(response.status).toBe(401)
    expect(getWorkspace).not.toHaveBeenCalled()
  })

  it("uses indistinguishable 404 responses for missing and unauthorized workspaces", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never)
    vi.mocked(getWorkspace).mockResolvedValue(null)
    const response = await request()
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" })
    expect(searchWorkspace).not.toHaveBeenCalled()
  })

  it.each([
    ["?workspaceSlug=product&q=plan", 400],
    ["?orgSlug=acme&q=plan", 400],
    ["?orgSlug=acme&workspaceSlug=product&q=a", 400],
    [`?orgSlug=acme&workspaceSlug=product&q=${"x".repeat(101)}`, 400],
  ])("rejects malformed search input", async (query, status) => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never)
    const response = await request(query)
    expect(response.status).toBe(status)
    expect(getWorkspace).not.toHaveBeenCalled()
  })

  it("searches only the workspace resolved from membership and disables caching", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never)
    vi.mocked(getWorkspace).mockResolvedValue({ id: "workspace-1" } as never)
    vi.mocked(searchWorkspace).mockResolvedValue({ query: "plan", groups: [] })

    const response = await request("?orgSlug=acme&workspaceSlug=product&q=%20plan%20")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(getWorkspace).toHaveBeenCalledWith("acme", "product", "user-1")
    expect(searchWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1", orgSlug: "acme", workspaceSlug: "product", query: "plan",
    })
  })
})
