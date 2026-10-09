import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getWorkspace: vi.fn(),
  docFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.getWorkspace }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    doc: { findMany: mocks.docFindMany },
    artifact: { findMany: mocks.artifactFindMany },
  }),
}))

import { GET } from "@/app/api/docs-tree/route"

const get = (qs = "?orgSlug=acme&workspaceSlug=main") => GET(new Request(`http://localhost/api/docs-tree${qs}`))

describe("GET /api/docs-tree", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.getWorkspace.mockResolvedValue({ id: "ws-1" })
    mocks.docFindMany.mockResolvedValue([])
    mocks.artifactFindMany.mockResolvedValue([])
  })

  it("rejects anonymous callers", async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("requires both workspace slugs", async () => {
    expect((await get("?orgSlug=acme")).status).toBe(400)
    expect((await get("")).status).toBe(400)
  })

  it("404s a workspace the user is not a member of, without querying docs", async () => {
    mocks.getWorkspace.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(mocks.getWorkspace).toHaveBeenCalledWith("acme", "main", "user-1")
    expect(mocks.docFindMany).not.toHaveBeenCalled()
  })

  it("returns the nested doc tree and artifacts, scoped to the workspace", async () => {
    mocks.docFindMany.mockResolvedValue([
      { id: "child", title: "Child", icon: null, parentId: "root", sortOrder: 0, docType: "DOC" },
      { id: "root", title: "Root", icon: null, parentId: null, sortOrder: 0, docType: "DOC" },
    ])
    mocks.artifactFindMany.mockResolvedValue([{ id: "a1", title: "Diagram", sourceType: "UPLOAD" }])

    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workspaceId: string
      docs: { id: string; children: { id: string }[] }[]
      artifacts: { id: string }[]
    }
    expect(body.workspaceId).toBe("ws-1")
    expect(body.docs.map((d) => d.id)).toEqual(["root"])
    expect(body.docs[0].children.map((c) => c.id)).toEqual(["child"])
    expect(body.artifacts.map((a) => a.id)).toEqual(["a1"])
    expect(mocks.docFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1" })
    expect(mocks.artifactFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", status: "ACTIVE" })
  })
})
