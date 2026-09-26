import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  db: {
    doc: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    docVersion: { create: vi.fn() },
  },
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  hydrateDocument: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/document-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/document-service")>("@/lib/document-service")
  return {
    ...actual,
    createDocument: mocks.createDocument,
    updateDocument: mocks.updateDocument,
    deleteDocument: mocks.deleteDocument,
    hydrateDocument: mocks.hydrateDocument,
  }
})

import {
  sanitizeTitleSegment,
  deriveOperationId,
  listPaths,
  resolvePath,
  readPath,
  writePath,
  deletePath,
  movePath,
  recordConflictingSnapshot,
  DocFsError,
} from "@/lib/doc-fs"

const WS = "workspace-1"

function row(overrides: Partial<{
  id: string; title: string; parentId: string | null; roadmapItemId: string | null; docType: string; updatedAt: Date; sortOrder: number
}> = {}) {
  return {
    id: "doc-1",
    title: "Untitled",
    parentId: null,
    roadmapItemId: null,
    docType: "STANDARD",
    updatedAt: new Date("2026-01-01"),
    sortOrder: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("sanitizeTitleSegment", () => {
  it("replaces filesystem-illegal characters with underscores", () => {
    expect(sanitizeTitleSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j")
  })

  it("trims leading/trailing whitespace and trailing dots", () => {
    expect(sanitizeTitleSegment("  Q3 Plan.  ")).toBe("Q3 Plan")
    expect(sanitizeTitleSegment("weird...")).toBe("weird")
  })

  it("strips control characters", () => {
    expect(sanitizeTitleSegment("a\x00b\x1fc")).toBe("a_b_c")
  })

  it("falls back to Untitled for an empty or all-illegal title", () => {
    expect(sanitizeTitleSegment("   ")).toBe("Untitled")
    expect(sanitizeTitleSegment("///")).toBe("___")
  })

  it("truncates to 200 UTF-8 bytes without leaving a mangled trailing character", () => {
    const title = "日".repeat(150) // 3 bytes each in UTF-8 = 450 bytes, well over the cap
    const result = sanitizeTitleSegment(title)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(200)
    expect(result).not.toContain("�")
  })

  it("is idempotent for an already-clean title", () => {
    expect(sanitizeTitleSegment("Q3 Plan")).toBe("Q3 Plan")
  })
})

describe("deriveOperationId", () => {
  const OPERATION_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  it("produces a syntactically valid UUID satisfying document-service's format check", () => {
    expect(deriveOperationId("turn-1", "doc-a")).toMatch(OPERATION_ID_FORMAT)
  })

  it("is deterministic for the same inputs", () => {
    expect(deriveOperationId("turn-1", "doc-a")).toBe(deriveOperationId("turn-1", "doc-a"))
  })

  it("differs when either input differs", () => {
    expect(deriveOperationId("turn-1", "doc-a")).not.toBe(deriveOperationId("turn-1", "doc-b"))
    expect(deriveOperationId("turn-1", "doc-a")).not.toBe(deriveOperationId("turn-2", "doc-a"))
  })
})

describe("listPaths / resolvePath", () => {
  it("nests children under their sanitized parent path", async () => {
    mocks.db.doc.findMany.mockResolvedValue([
      row({ id: "root", title: "Product" }),
      row({ id: "child", title: "Roadmap", parentId: "root" }),
    ])
    const nodes = await listPaths(WS)
    expect(nodes.find((n) => n.docId === "root")?.path).toBe("Product")
    expect(nodes.find((n) => n.docId === "child")?.path).toBe("Product/Roadmap")
    expect(nodes.find((n) => n.docId === "root")?.hasChildren).toBe(true)
  })

  it("disambiguates same-titled siblings with the first 8 hex chars of docId, first-one-bare", async () => {
    mocks.db.doc.findMany.mockResolvedValue([
      row({ id: "11111111-aaaa-bbbb-cccc-dddddddddddd", title: "Notes" }),
      row({ id: "22222222-aaaa-bbbb-cccc-dddddddddddd", title: "Notes" }),
    ])
    const nodes = await listPaths(WS)
    const paths = nodes.map((n) => n.path).sort()
    expect(paths).toEqual(["Notes", "Notes (22222222)"])
  })

  it("recomputes collisions fresh every call -- a stopped collision goes back to a bare path", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "a", title: "Notes" }), row({ id: "b", title: "Notes" })])
    const first = await listPaths(WS)
    expect(first.find((n) => n.docId === "a")?.path).toBe("Notes")
    expect(first.find((n) => n.docId === "b")?.path).toBe("Notes (b)")
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "a", title: "Notes" }), row({ id: "b", title: "Renamed" })])
    const second = await listPaths(WS)
    expect(second.find((n) => n.docId === "b")?.path).toBe("Renamed")
  })

  it("promotes a doc with a dangling parentId to the root", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "orphan", title: "Orphan", parentId: "missing-parent" })])
    const nodes = await listPaths(WS)
    expect(nodes).toEqual([expect.objectContaining({ docId: "orphan", path: "Orphan" })])
  })

  it("resolvePath returns null for a path that doesn't exist", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    expect(await resolvePath(WS, "Nope")).toBeNull()
  })
})

describe("readPath", () => {
  it("re-injects compass_ reserved keys, overriding any same-named user metadata", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Vision", roadmapItemId: "ri-1" })])
    mocks.db.doc.findUnique.mockResolvedValue({
      id: "doc-1",
      workspaceId: WS,
      title: "Vision",
      docType: "STANDARD",
      roadmapItemId: "ri-1",
      metadata: { status: "draft", compass_doc_id: "forged" },
      revision: "rev-1",
      content: null,
      storageProvider: null,
      contentRef: null,
    })
    mocks.hydrateDocument.mockResolvedValue({ content: "# Hello" })

    const result = await readPath(WS, "Vision")
    expect(result?.revision).toBe("rev-1")
    expect(result?.content).toContain("compass_doc_id: doc-1")
    expect(result?.content).toContain("compass_doc_type: STANDARD")
    expect(result?.content).toContain("compass_roadmap_item_id: ri-1")
    expect(result?.content).toContain("status: draft")
    expect(result?.content).not.toContain("forged")
    expect(result?.content).toContain("# Hello")
  })

  it("returns null when the doc belongs to a different workspace", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Vision" })])
    mocks.db.doc.findUnique.mockResolvedValue({ id: "doc-1", workspaceId: "other-workspace" })
    expect(await readPath(WS, "Vision")).toBeNull()
  })

  it("returns null for a path that doesn't resolve", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    expect(await readPath(WS, "Nope")).toBeNull()
  })
})

describe("writePath", () => {
  beforeEach(() => {
    mocks.db.doc.findFirst.mockResolvedValue(null) // nextSortOrder: no siblings yet
  })

  it("creates a doc at a new root path", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    mocks.createDocument.mockResolvedValue({ id: "new-doc", revision: "rev-new" })
    const result = await writePath(WS, "Vision", "# Hello", { authorName: "Agent" })
    expect(result).toEqual({ docId: "new-doc", created: true, revision: "rev-new", path: "Vision" })
    expect(mocks.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, parentId: null, title: "Vision", content: "# Hello", sortOrder: 0 }),
      expect.objectContaining({ authorName: "Agent" })
    )
  })

  it("updates the doc already at that path instead of creating a duplicate", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Vision" })])
    mocks.updateDocument.mockResolvedValue({ id: "doc-1", revision: "rev-2" })
    const result = await writePath(WS, "Vision", "# Updated", { authorName: "Agent", expectedRevision: "rev-1" })
    expect(result).toEqual({ docId: "doc-1", created: false, revision: "rev-2", path: "Vision" })
    expect(mocks.updateDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ content: "# Updated" }),
      expect.objectContaining({ expectedRevision: "rev-1", authorName: "Agent" })
    )
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it("creates missing intermediate parent directories implicitly", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    mocks.createDocument
      .mockResolvedValueOnce({ id: "parent-doc", revision: "r1" })
      .mockResolvedValueOnce({ id: "leaf-doc", revision: "r2" })
    const result = await writePath(WS, "Product/Roadmap", "content", { authorName: "Agent" })
    expect(mocks.createDocument).toHaveBeenCalledTimes(2)
    expect(mocks.createDocument.mock.calls[0][0]).toMatchObject({ parentId: null, title: "Product", content: null })
    expect(mocks.createDocument.mock.calls[1][0]).toMatchObject({ parentId: "parent-doc", title: "Roadmap" })
    expect(result.docId).toBe("leaf-doc")
  })

  it("strips YAML frontmatter into metadata, keeping compass_-prefixed keys out of user metadata", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    mocks.createDocument.mockResolvedValue({ id: "new-doc", revision: "rev-new" })
    const content = "---\nstatus: draft\ncompass_doc_id: forged\n---\n\n# Body\n"
    await writePath(WS, "Vision", content, { authorName: "Agent" })
    const call = mocks.createDocument.mock.calls[0][0]
    expect(call.content).toBe("# Body\n")
    expect(call.metadata).toEqual({ status: "draft" })
  })

  it("preserves content exactly when there is no frontmatter block (no unconditional trim)", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    mocks.createDocument.mockResolvedValue({ id: "new-doc", revision: "rev-new" })
    const content = "﻿  body 日本語\n"
    await writePath(WS, "Vision", content, { authorName: "Agent" })
    expect(mocks.createDocument.mock.calls[0][0].content).toBe(content)
  })

  it("rejects an empty path", async () => {
    await expect(writePath(WS, "", "content", { authorName: "Agent" })).rejects.toThrow(DocFsError)
  })
})

describe("deletePath", () => {
  it("throws not-found for a path that doesn't resolve", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    await expect(deletePath(WS, "Nope", { authorName: "Agent" })).rejects.toThrow(/No doc at path/)
  })

  it("deletes a childless doc directly", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Vision" })])
    await deletePath(WS, "Vision", { authorName: "Agent" })
    expect(mocks.deleteDocument).toHaveBeenCalledWith("doc-1", expect.objectContaining({ workspaceId: WS }))
  })

  it("refuses to delete a doc with children unless recursive is set", async () => {
    mocks.db.doc.findMany.mockResolvedValue([
      row({ id: "parent", title: "Product" }),
      row({ id: "child", title: "Roadmap", parentId: "parent" }),
    ])
    await expect(deletePath(WS, "Product", { authorName: "Agent" })).rejects.toThrow(/has children/)
    expect(mocks.deleteDocument).not.toHaveBeenCalled()
  })

  it("deletes every descendant bottom-up when recursive is set", async () => {
    mocks.db.doc.findMany.mockResolvedValue([
      row({ id: "parent", title: "Product" }),
      row({ id: "child", title: "Roadmap", parentId: "parent" }),
      row({ id: "grandchild", title: "Q3", parentId: "child" }),
    ])
    const order: string[] = []
    mocks.deleteDocument.mockImplementation(async (docId: string) => {
      order.push(docId)
    })
    await deletePath(WS, "Product", { authorName: "Agent", recursive: true })
    expect(order).toEqual(["grandchild", "child", "parent"])
  })
})

describe("movePath", () => {
  it("renames within the same parent", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Old Name" })])
    mocks.db.doc.findFirst.mockResolvedValue(null)
    mocks.updateDocument.mockResolvedValue({ id: "doc-1", revision: "rev-2" })
    const result = await movePath(WS, "Old Name", "New Name", { authorName: "Agent" })
    expect(mocks.updateDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ title: "New Name", parentId: null }),
      expect.anything()
    )
    expect(result).toEqual({ docId: "doc-1", revision: "rev-2" })
  })

  it("reparents by changing the destination's directory", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Notes" }), row({ id: "folder-doc", title: "Archive" })])
    mocks.db.doc.findFirst.mockResolvedValue(null)
    mocks.updateDocument.mockResolvedValue({ id: "doc-1", revision: "rev-2" })
    await movePath(WS, "Notes", "Archive/Notes", { authorName: "Agent" })
    expect(mocks.updateDocument).toHaveBeenCalledWith("doc-1", expect.objectContaining({ title: "Notes", parentId: "folder-doc" }), expect.anything())
  })

  it("throws not-found for a source path that doesn't resolve", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    await expect(movePath(WS, "Nope", "Somewhere", { authorName: "Agent" })).rejects.toThrow(/No doc at path/)
  })

  it("rejects moving a doc into its own subtree", async () => {
    mocks.db.doc.findMany.mockResolvedValue([
      row({ id: "parent", title: "Product" }),
      row({ id: "child", title: "Roadmap", parentId: "parent" }),
    ])
    await expect(movePath(WS, "Product", "Product/Roadmap/Nested", { authorName: "Agent" })).rejects.toThrow(/own subtree/)
  })

  it("is a no-op when the destination equals the source", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row({ id: "doc-1", title: "Vision" })])
    await movePath(WS, "Vision", "Vision", { authorName: "Agent" })
    expect(mocks.updateDocument).not.toHaveBeenCalled()
  })
})

describe("recordConflictingSnapshot", () => {
  it("creates a labeled, non-current DocVersion without touching the live doc", async () => {
    mocks.db.doc.findUnique.mockResolvedValue({ id: "doc-1", title: "Vision", icon: null })
    await recordConflictingSnapshot("doc-1", "# Agent's would-be content", "Compass Agent")
    expect(mocks.db.docVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          docId: "doc-1",
          content: "# Agent's would-be content",
          label: expect.stringContaining("Agent's conflicting edit — not applied"),
          createdByName: "Compass Agent",
        }),
      })
    )
    expect(mocks.updateDocument).not.toHaveBeenCalled()
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it("is a no-op if the doc no longer exists", async () => {
    mocks.db.doc.findUnique.mockResolvedValue(null)
    await recordConflictingSnapshot("doc-1", "content", "Agent")
    expect(mocks.db.docVersion.create).not.toHaveBeenCalled()
  })
})
