/**
 * Id-addressed and create-only doc-fs operations the sandbox reconciler relies on
 * (ADR 0019 §2.4): they must keep working after an earlier action in the same
 * pass renamed an ancestor, must never recurse on delete, and must never turn a
 * create into a silent overwrite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  db: {
    doc: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    docVersion: { create: vi.fn() },
    docOperation: { findUnique: vi.fn() },
  },
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  hydrateDocument: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))
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

import { createPath, deleteDocById, listPaths, moveDocById, resolveById, writeDocById, DocFsError } from "@/lib/doc-fs"

const WS = "workspace-1"
const row = (id: string, title: string, parentId: string | null = null, docType = "STANDARD") => ({
  id,
  title,
  parentId,
  roadmapItemId: null,
  docType,
  updatedAt: new Date("2026-01-01"),
  sortOrder: 0,
})
const OPTS = { authorName: "Compass Agent", operationId: "00000000-0000-4000-8000-000000000001", expectedRevision: "rev-1" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateDocument.mockResolvedValue({ id: "doc", revision: "rev-2", updatedAt: new Date() })
  mocks.createDocument.mockResolvedValue({ id: "new-doc", revision: "rev-n", updatedAt: new Date() })
  mocks.db.doc.findFirst.mockResolvedValue(null)
  mocks.db.docOperation.findUnique.mockResolvedValue(null)
})

describe("titles the sandbox could not see are escaped in listPaths", () => {
  it("never produces a dot-prefixed, node_modules or _doc.md path segment", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("a", ".env"), row("b", "node_modules"), row("c", "_doc.md", "a"), row("d", "ok")])
    const paths = (await listPaths(WS)).map((n) => n.path)
    expect(paths).toEqual(["_env", "_env/_doc.md_", "node_modules_", "ok"])
    for (const p of paths) for (const seg of p.split("/")) {
      expect(seg.startsWith(".")).toBe(false)
      expect(seg).not.toBe("node_modules")
      expect(seg).not.toBe("_doc.md")
    }
  })

  it("keeps two docs whose escaped titles collide apart", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("11111111-0000-0000-0000-000000000000", ".env"), row("22222222-0000-0000-0000-000000000000", "_env")])
    expect((await listPaths(WS)).map((n) => n.path)).toEqual(["_env", "_env (22222222)"])
  })
})

describe("id-addressed operations survive an earlier rename in the same pass", () => {
  it("resolves a child by id to its CURRENT path after the parent was renamed", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("parent", "New Name"), row("child", "Child", "parent")])
    expect((await resolveById(WS, "child"))?.path).toBe("New Name/Child")
    expect(await resolveById(WS, "missing")).toBeNull()
  })

  it("writeDocById updates by id with the supplied revision and operation", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("doc", "Vision")])
    await writeDocById(WS, "doc", "---\nstatus: draft\n---\nbody", OPTS)
    expect(mocks.updateDocument).toHaveBeenCalledWith(
      "doc",
      expect.objectContaining({ content: "body" }),
      expect.objectContaining({ expectedRevision: "rev-1", operationId: OPTS.operationId })
    )
  })

  it("writeDocById reports a doc deleted meanwhile as not-found", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    await expect(writeDocById(WS, "gone", "x", OPTS)).rejects.toMatchObject({ code: "not-found" })
    expect(mocks.updateDocument).not.toHaveBeenCalled()
  })

  it("moveDocById moves by id into a destination that only exists after an earlier move", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("parent", "B"), row("child", "Child", "parent")])
    await moveDocById(WS, "child", "B/Renamed", OPTS)
    expect(mocks.updateDocument).toHaveBeenCalledWith("child", expect.objectContaining({ title: "Renamed", parentId: "parent" }), expect.anything())
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it("moveDocById refuses to move a doc into its own subtree", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("a", "A")])
    await expect(moveDocById(WS, "a", "A/Inside", OPTS)).rejects.toMatchObject({ code: "invalid-move" })
  })
})

describe("deleteDocById is single-doc and never recursive", () => {
  it("deletes a leaf with its revision", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("leaf", "Leaf")])
    await deleteDocById(WS, "leaf", OPTS)
    expect(mocks.deleteDocument).toHaveBeenCalledTimes(1)
    expect(mocks.deleteDocument).toHaveBeenCalledWith("leaf", expect.objectContaining({ expectedRevision: "rev-1", workspaceId: WS }))
  })

  it("throws has-children for a parent and deletes nothing, not even its children", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("parent", "P"), row("child", "C", "parent")])
    await expect(deleteDocById(WS, "parent", OPTS)).rejects.toMatchObject({ code: "has-children" })
    expect(mocks.deleteDocument).not.toHaveBeenCalled()
  })

  it("throws not-found for an unknown id", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    await expect(deleteDocById(WS, "nope", OPTS)).rejects.toBeInstanceOf(DocFsError)
  })
})

describe("write side sanitizes segments so paths round-trip with listPaths", () => {
  it("writes to '.env/foo' resolve against the escaped '_env/foo' instead of creating a duplicate each time", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("env", ".env"), row("foo", "foo", "env")])
    const result = await (await import("@/lib/doc-fs")).writePath(WS, ".env/foo", "body", OPTS)
    expect(result).toMatchObject({ created: false, path: "_env/foo" })
    expect(mocks.updateDocument).toHaveBeenCalledWith("foo", expect.anything(), expect.anything())
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it("creates new docs under the escaped title", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    await createPath(WS, "Q3: Plan/$notes", "body", { authorName: "Agent" })
    const titles = mocks.createDocument.mock.calls.map((c) => c[0].title)
    expect(titles).toEqual(["Q3_ Plan", "_notes"])
  })
})

describe("moveDocById onto an occupied path", () => {
  it("refuses to take a path another doc holds (no silent '(xxxxxxxx)' sibling)", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("mover", "Old"), row("human", "Taken")])
    await expect(moveDocById(WS, "mover", "Taken", OPTS)).rejects.toMatchObject({ code: "exists" })
    expect(mocks.updateDocument).not.toHaveBeenCalled()
  })

  it("allows it when the occupant is a doc the same pass is moving or deleting", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("mover", "Old"), row("leaving", "Taken")])
    await moveDocById(WS, "mover", "Taken", { ...OPTS, occupantMayLeave: new Set(["leaving"]) })
    expect(mocks.updateDocument).toHaveBeenCalledWith("mover", expect.objectContaining({ title: "Taken" }), expect.anything())
  })

  it("a move onto its own current path is a no-op, not a conflict", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("mover", "Same")])
    await expect(moveDocById(WS, "mover", "Same", OPTS)).resolves.toMatchObject({ docId: "mover" })
  })
})

describe("createPath never silently updates an existing doc", () => {
  it("treats a path occupied by its own earlier create (operation receipt present) as a replay, not a conflict", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("mine", "Fresh")])
    mocks.db.docOperation.findUnique.mockResolvedValue({ id: "receipt" })
    await createPath(WS, "Fresh", "body", OPTS)
    expect(mocks.createDocument).toHaveBeenCalledTimes(1) // createDocument replays the stored result for the same receipt
  })

  it("throws exists when something already lives at the path", async () => {
    mocks.db.doc.findMany.mockResolvedValue([row("human", "Plan")])
    await expect(createPath(WS, "Plan", "agent content", OPTS)).rejects.toMatchObject({ code: "exists" })
    expect(mocks.updateDocument).not.toHaveBeenCalled()
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it("creates when the path is free", async () => {
    mocks.db.doc.findMany.mockResolvedValue([])
    const result = await createPath(WS, "Fresh", "---\nstatus: draft\n---\nbody", { authorName: "Compass Agent" })
    expect(result).toMatchObject({ docId: "new-doc", created: true, path: "Fresh" })
    expect(mocks.createDocument).toHaveBeenCalledWith(expect.objectContaining({ title: "Fresh", content: "body" }), expect.anything())
  })
})
