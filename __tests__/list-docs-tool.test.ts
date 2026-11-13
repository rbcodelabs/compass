/** list_docs handler: filter by kind, newest first, bounded limit, shape. The registered surface is in list-docs-tool-schema.test.ts. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ listPaths: vi.fn(), workspace: vi.fn() }))

vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findUnique: mocks.workspace } }) }))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: null, authorName: "MCP Agent" }) }))
vi.mock("@/lib/doc-fs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/doc-fs")>("@/lib/doc-fs")
  return { ...actual, listPaths: mocks.listPaths }
})

import { listLibraryDocs } from "@/lib/doc-fs-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const node = (n: number, kind: string | null, updated: string, docType = "STANDARD") => ({
  path: `Folder/Doc ${n}`,
  docId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  title: `Doc ${n}`,
  parentId: null,
  roadmapItemId: null,
  docType,
  kind,
  hasChildren: false,
  updatedAt: new Date(updated),
})
const items = (result: Awaited<ReturnType<typeof listLibraryDocs>>) => (result.structuredContent.data as { items: Record<string, unknown>[]; count: number }).items

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspace.mockResolvedValue({ id: WS, slug: "alpha", organization: { slug: "acme" } })
})

describe("list_docs handler", () => {
  beforeEach(() => {
    mocks.listPaths.mockResolvedValue([
      node(1, "ADR", "2026-11-01T00:00:00Z"),
      node(2, "QA_REPORT", "2026-11-09T00:00:00Z"),
      node(3, "ADR", "2026-11-05T00:00:00Z"),
      node(4, null, "2026-11-08T00:00:00Z"),
      node(5, "ADR", "2026-11-03T00:00:00Z", "SPEC"),
    ])
  })

  it("returns only the docs of the requested kind, most recently updated first", async () => {
    const result = await listLibraryDocs({ workspaceId: WS, kind: "ADR" })
    expect(result.structuredContent.ok).toBe(true)
    expect(items(result).map((item) => item.title)).toEqual(["Doc 3", "Doc 5", "Doc 1"])
    expect((result.structuredContent.data as { count: number }).count).toBe(3)
  })

  it("returns every doc, kind or not, when no kind is given", async () => {
    const result = await listLibraryDocs({ workspaceId: WS })
    expect(items(result).map((item) => item.title)).toEqual(["Doc 2", "Doc 4", "Doc 3", "Doc 5", "Doc 1"])
    expect(items(result).find((item) => item.title === "Doc 4")?.kind).toBeNull()
  })

  it("reports id, path, title, kind, docType, updatedAt and url for each doc", async () => {
    const [first] = items(await listLibraryDocs({ workspaceId: WS, kind: "QA_REPORT" }))
    expect(first).toMatchObject({
      id: "00000000-0000-4000-8000-000000000002",
      path: "Folder/Doc 2",
      title: "Doc 2",
      kind: "QA_REPORT",
      docType: "STANDARD",
    })
    expect(new Date(first.updatedAt as string).toISOString()).toBe("2026-11-09T00:00:00.000Z")
    expect(first.url).toEqual(expect.stringContaining("/acme/alpha/docs/00000000-0000-4000-8000-000000000002"))
  })

  it("keeps a SPEC doc visible by its kind like any other doc", async () => {
    const result = await listLibraryDocs({ workspaceId: WS, kind: "ADR" })
    expect(items(result).find((item) => item.title === "Doc 5")?.docType).toBe("SPEC")
  })

  it("answers an empty match with a successful empty list", async () => {
    const result = await listLibraryDocs({ workspaceId: WS, kind: "NOTE" })
    expect(result.structuredContent.ok).toBe(true)
    expect(items(result)).toEqual([])
  })

  it("rejects a kind that is not one of the known kinds", async () => {
    const result = await listLibraryDocs({ workspaceId: WS, kind: "SPEC" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.message).toMatch(/kind/i)
  })

  it("fails for an unknown workspace", async () => {
    mocks.workspace.mockResolvedValue(null)
    expect((await listLibraryDocs({ workspaceId: WS })).structuredContent.ok).toBe(false)
  })
})

describe("list_docs limit", () => {
  beforeEach(() => {
    mocks.listPaths.mockResolvedValue(Array.from({ length: 260 }, (_, index) => node(index + 1, "NOTE", new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString())))
  })

  it("defaults to 50", async () => {
    expect(items(await listLibraryDocs({ workspaceId: WS }))).toHaveLength(50)
  })

  it("honours a smaller limit and caps a larger one at 200", async () => {
    expect(items(await listLibraryDocs({ workspaceId: WS, limit: 7 }))).toHaveLength(7)
    expect(items(await listLibraryDocs({ workspaceId: WS, limit: 500 }))).toHaveLength(200)
  })

  it("takes the newest docs first before limiting", async () => {
    expect(items(await listLibraryDocs({ workspaceId: WS, limit: 1 }))[0].title).toBe("Doc 260")
  })
})
