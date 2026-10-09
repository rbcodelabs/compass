import { describe, it, expect, vi, beforeEach } from "vitest"

const mockDoc = { findUnique: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ doc: mockDoc }) }))

const updateDocument = vi.fn()
vi.mock("@/lib/document-service", () => {
  class DocumentError extends Error {
    constructor(public readonly code: string, detail?: string) {
      super(detail ?? code)
    }
  }
  return {
    DocumentError,
    documentRevision: (d: { revision?: string | null }) => d.revision ?? "legacy",
    hydrateDocument: async (_ws: string, row: object) => row,
    updateDocument: (...args: unknown[]) => updateDocument(...args),
  }
})

vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: (authorName = "MCP Agent") => ({ authorId: "u1", authorName, actorKey: "USER:u1" }) }))

import { DocumentError } from "@/lib/document-service"
import { editDocumentBody, MAX_EDIT_ATTEMPTS } from "@/lib/document-edit"
import { applyTextEdits, editDoc, editCanvas } from "@/lib/doc-edit-tool-handlers"

const row = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  workspaceId: "w1",
  title: "T",
  docType: "DOC",
  content: "alpha beta",
  revision: "r1",
  updatedAt: new Date("2026-01-01"),
  ...over,
})
const saved = (revision: string) => ({ id: "d1", title: "T", revision, updatedAt: new Date("2026-01-02") })
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

beforeEach(() => {
  mockDoc.findUnique.mockReset()
  updateDocument.mockReset()
})

describe("applyTextEdits", () => {
  it("replaces a unique match", () => {
    expect(applyTextEdits("a b c", [{ oldString: "b", newString: "X" }])).toEqual({ ok: true, content: "a X c", replacements: 1 })
  })
  it("rejects ambiguous matches unless replaceAll", () => {
    const r = applyTextEdits("x x", [{ oldString: "x", newString: "y" }])
    expect(r.ok).toBe(false)
    expect(applyTextEdits("x x", [{ oldString: "x", newString: "y", replaceAll: true }])).toEqual({ ok: true, content: "y y", replacements: 2 })
  })
  it("rejects missing, empty and identical edits", () => {
    expect(applyTextEdits("abc", [{ oldString: "zzz", newString: "y" }]).ok).toBe(false)
    expect(applyTextEdits("abc", [{ oldString: "", newString: "y" }]).ok).toBe(false)
    expect(applyTextEdits("abc", [{ oldString: "a", newString: "a" }]).ok).toBe(false)
    expect(applyTextEdits("abc", []).ok).toBe(false)
  })
  it("inserts special replacement patterns literally", () => {
    expect(applyTextEdits("price", [{ oldString: "price", newString: "$& $1" }])).toMatchObject({ content: "$& $1" })
  })
  it("applies in order and rejects the batch if a later edit fails", () => {
    expect(applyTextEdits("a", [{ oldString: "a", newString: "b" }, { oldString: "b", newString: "c" }])).toMatchObject({ content: "c" })
    const r = applyTextEdits("a", [{ oldString: "a", newString: "b" }, { oldString: "q", newString: "c" }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^edits\[1\]/)
  })
})

describe("editDocumentBody", () => {
  it("writes with a CAS revision and a fresh operation id", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    updateDocument.mockResolvedValue(saved("r2"))
    const out = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content + "!", result: 1 }))
    expect(out).toMatchObject({ ok: true, changed: true, attempts: 1, doc: { revision: "r2" } })
    const [, change, opts] = updateDocument.mock.calls[0]
    expect(change).toEqual({ content: "alpha beta!" })
    expect(opts.expectedRevision).toBe("r1")
    expect(opts.operationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("does not write when nothing changed", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    const out = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content, result: 0 }))
    expect(out).toMatchObject({ ok: true, changed: false })
    expect(updateDocument).not.toHaveBeenCalled()
  })

  it("retries on conflict against the fresh body when unpinned", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ revision: "r9", content: "alpha beta gamma" }))
    updateDocument.mockRejectedValueOnce(new DocumentError("revision-conflict")).mockResolvedValueOnce(saved("r10"))
    const out = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content.replace("alpha", "A"), result: 0 }))
    expect(out).toMatchObject({ ok: true, attempts: 2 })
    expect(updateDocument.mock.calls[1][1]).toEqual({ content: "A beta gamma" })
    expect(updateDocument.mock.calls[1][2].expectedRevision).toBe("r9")
  })

  it("gives up after MAX_EDIT_ATTEMPTS", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    updateDocument.mockRejectedValue(new DocumentError("revision-conflict"))
    const out = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content + "!", result: 0 }))
    expect(out).toMatchObject({ ok: false, code: "revision-conflict" })
    expect(updateDocument).toHaveBeenCalledTimes(MAX_EDIT_ATTEMPTS)
  })

  it("enforces a pinned revision without retrying", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    const stale = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content + "!", result: 0 }), { expectedRevision: "old" })
    expect(stale).toMatchObject({ ok: false, code: "revision-conflict" })
    expect(updateDocument).not.toHaveBeenCalled()

    updateDocument.mockRejectedValue(new DocumentError("revision-conflict"))
    const raced = await editDocumentBody("d1", (d) => ({ ok: true, content: d.content + "!", result: 0 }), { expectedRevision: "r1" })
    expect(raced).toMatchObject({ ok: false, code: "revision-conflict" })
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it("reports not-found, rejected transforms and invalid canvases", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)
    expect(await editDocumentBody("d1", () => ({ ok: true, content: "x", result: 0 }))).toMatchObject({ ok: false, code: "not-found" })

    mockDoc.findUnique.mockResolvedValueOnce(row())
    expect(await editDocumentBody("d1", () => ({ ok: false, error: "nope" }))).toEqual({ ok: false, code: "rejected", error: "nope" })

    mockDoc.findUnique.mockResolvedValueOnce(row())
    updateDocument.mockRejectedValueOnce(new DocumentError("invalid-canvas", "bad canvas"))
    expect(await editDocumentBody("d1", (d) => ({ ok: true, content: d.content + "!", result: 0 }))).toMatchObject({ ok: false, code: "rejected" })
  })
})

describe("editDoc", () => {
  it("rejects conflicting argument shapes", async () => {
    expect((await editDoc({ docId: "d1", oldString: "a", newString: "b", edits: [{ oldString: "a", newString: "b" }] })).structuredContent.ok).toBe(false)
    expect((await editDoc({ docId: "d1", oldString: "a" })).structuredContent.ok).toBe(false)
  })

  it("edits text and reports the new revision", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    updateDocument.mockResolvedValue(saved("r2"))
    const r = await editDoc({ docId: "d1", oldString: "beta", newString: "gamma" })
    expect(r.structuredContent.ok).toBe(true)
    expect(text(r)).toContain("Revision: r2")
    expect(updateDocument.mock.calls[0][1]).toEqual({ content: "alpha gamma" })
  })

  it("surfaces a no-match as an error without writing", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    const r = await editDoc({ docId: "d1", oldString: "zzz", newString: "y" })
    expect(r.structuredContent.ok).toBe(false)
    expect(updateDocument).not.toHaveBeenCalled()
  })

  it("keeps a canvas valid after a text edit", async () => {
    const canvas = JSON.stringify({ nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" }], edges: [] })
    mockDoc.findUnique.mockResolvedValue(row({ docType: "CANVAS", content: canvas }))
    const broken = await editDoc({ docId: "d1", oldString: '"edges":[]', newString: '"edges":' })
    expect(broken.structuredContent.ok).toBe(false)
    expect(updateDocument).not.toHaveBeenCalled()
  })
})

describe("editCanvas", () => {
  const canvas = JSON.stringify({ nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" }], edges: [] })

  it("applies ops and saves the canonical canvas", async () => {
    mockDoc.findUnique.mockResolvedValue(row({ docType: "CANVAS", content: canvas }))
    updateDocument.mockResolvedValue(saved("r2"))
    const r = await editCanvas({ docId: "d1", ops: [{ op: "add_text", text: "new" }, { op: "add_edge", from: "t", to: "t" }] })
    expect(r.structuredContent.ok).toBe(true)
    expect(text(r)).toMatch(/1 node added/)
    const saved_ = JSON.parse(updateDocument.mock.calls[0][1].content)
    expect(saved_.nodes).toHaveLength(2)
  })

  it("refuses non-canvas docs and bad ops without writing", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    expect((await editCanvas({ docId: "d1", ops: [{ op: "add_text", text: "x" }] })).structuredContent.ok).toBe(false)
    mockDoc.findUnique.mockResolvedValue(row({ docType: "CANVAS", content: canvas }))
    expect((await editCanvas({ docId: "d1", ops: [{ op: "remove", node: "zzz" }] })).structuredContent.ok).toBe(false)
    expect(updateDocument).not.toHaveBeenCalled()
  })
})
