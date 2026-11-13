/** QA (stage 1): classifier edge titles, library helpers with no docs, list_docs on canvas docs and odd limits. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ listPaths: vi.fn(), workspace: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findUnique: mocks.workspace } }) }))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: null, authorName: "MCP Agent" }) }))
vi.mock("@/lib/doc-fs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/doc-fs")>("@/lib/doc-fs")
  return { ...actual, listPaths: mocks.listPaths }
})

import { classifyDocKind } from "@/lib/doc-kind-backfill"
import { groupDocsByKind, kindCounts, parseLibraryView, recentDocs } from "@/lib/docs-library"
import { docKindLabel, normalizeDocKind } from "@/lib/doc-kinds"
import { listLibraryDocs } from "@/lib/doc-fs-tool-handlers"

const c = (title: string, parentTitle: string | null = null) => classifyDocKind({ title, parentTitle })

describe("classifier: edge titles that stay unset (characterisation, green)", () => {
  it.each(["ADRIAN notes", "ADRs overview", "ADR_0001", "Notes on ADR 12", "Adrenaline", "", "   "])("%j is unset", (t) => expect(c(t)).toBeNull())
  it.each(["ADR", "adr", "ADR 7", "ADR-0020 x", "  ADR - padded", "Adr: x"])("%j is an ADR", (t) => expect(c(t)).toBe("ADR"))
  it("a leading-space and mixed-case QA Report / parent still match", () => {
    expect(c("  qa REPORT x")).toBe("QA_REPORT")
    expect(c("x", "  qa reports  ")).toBe("QA_REPORT")
    expect(c("x", "Design ")).toBe("DESIGN")
  })
  it("a null kind and a deep parent: only the direct parent counts", () => {
    expect(c("x", "Architecture")).toBeNull()
  })
})

describe("classifier: year-like titles (DESIRED: not an ADR)", () => {
  // These are reported as a defect: NUMBERED_TITLE (^\d{4}[ .:-]) treats any four digit prefix that is not an ISO date as an ADR number.
  it.each(["2026 Roadmap", "2026 Planning notes", "2025: Year in review", "2026-Q1 plan", "1999 retrospective"])("%j stays unset", (t) => {
    expect(c(t)).toBeNull()
  })
})

describe("library helpers with no docs and odd kinds", () => {
  it("kindCounts of nothing lists every kind at zero", () => {
    const counts = kindCounts([])
    expect(counts.total).toBe(0)
    expect(counts.noType).toBe(0)
    expect(counts.byKind.map((k) => k.count)).toEqual([0, 0, 0, 0])
  })
  it("groupDocsByKind and recentDocs of nothing are empty", () => {
    expect(groupDocsByKind([])).toEqual([])
    expect(recentDocs([])).toEqual([])
    expect(recentDocs([], -5)).toEqual([])
  })
  it("an unrecognised stored kind reads as No type everywhere", () => {
    const docs = [{ id: "a", title: "A", kind: "SPEC", updatedAt: new Date(0) }]
    expect(kindCounts(docs).noType).toBe(1)
    expect(groupDocsByKind(docs)[0].kind).toBeNull()
    expect(normalizeDocKind("adr")).toBeNull()
    expect(docKindLabel("SPEC")).toBe("No type")
  })
  it("parseLibraryView falls back to overview for junk, arrays and empty", () => {
    expect(parseLibraryView(["recent", "by-type"])).toBe("overview")
    expect(parseLibraryView("RECENT")).toBe("overview")
    expect(parseLibraryView("")).toBe("overview")
    expect(parseLibraryView(undefined)).toBe("overview")
    expect(parseLibraryView("recent")).toBe("recent")
  })
  it("a title that is only whitespace sorts without throwing", () => {
    const docs = [1, 2].map((n) => ({ id: String(n), title: " ", kind: null, updatedAt: new Date(0) }))
    expect(recentDocs(docs)).toHaveLength(2)
  })
})

describe("list_docs edges", () => {
  const node = (n: number, kind: string | null, docType = "STANDARD") => ({
    path: `D${n}`, docId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `D${n}`, parentId: null, roadmapItemId: null,
    docType, kind, hasChildren: false, updatedAt: new Date(2026, 10, n),
  })
  const data = (r: Awaited<ReturnType<typeof listLibraryDocs>>) => r.structuredContent.data as { items: Record<string, unknown>[]; count: number; total: number }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspace.mockResolvedValue({ id: "w", slug: "s", organization: { slug: "o" } })
  })
  it("returns the kind of a CANVAS doc and filters it in", async () => {
    mocks.listPaths.mockResolvedValue([node(1, "DESIGN", "CANVAS"), node(2, null)])
    const out = data(await listLibraryDocs({ workspaceId: "w", kind: "DESIGN" }))
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ docType: "CANVAS", kind: "DESIGN" })
  })
  it("a workspace with zero docs says so and does not throw", async () => {
    mocks.listPaths.mockResolvedValue([])
    const r = await listLibraryDocs({ workspaceId: "w" })
    expect(data(r)).toMatchObject({ count: 0, total: 0 })
    expect(JSON.stringify(r)).toContain("No docs match")
  })
  it.each([0, -3, 0.4])("limit %s is clamped up to 1", async (limit) => {
    mocks.listPaths.mockResolvedValue([node(1, null), node(2, null)])
    expect(data(await listLibraryDocs({ workspaceId: "w", limit })).items).toHaveLength(1)
  })
  it("an unknown kind is refused without touching the tree", async () => {
    const r = await listLibraryDocs({ workspaceId: "w", kind: "SPEC" })
    expect(JSON.stringify(r)).toContain("Unknown kind")
    expect(mocks.listPaths).not.toHaveBeenCalled()
  })
  it("an unknown workspace is refused", async () => {
    mocks.workspace.mockResolvedValue(null)
    expect(JSON.stringify(await listLibraryDocs({ workspaceId: "w" }))).toContain("No workspace found")
  })
})
