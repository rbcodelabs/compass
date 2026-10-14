import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

const mocks = vi.hoisted(() => {
  const doc = { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() }
  const docVersion = { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() }
  const docOperation = { findUnique: vi.fn(), create: vi.fn() }
  return { db: { doc, docVersion, docOperation, docComment: { deleteMany: vi.fn() }, $transaction: vi.fn() }, putContent: vi.fn(), readContent: vi.fn() }
})
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/document-storage", () => ({
  isDocumentPilotWorkspace: (id: string) => id === "workspace-a",
  getDocumentStore: () => ({ putContent: mocks.putContent, readContent: mocks.readContent }),
}))

const current = { id: "doc-a", workspaceId: "workspace-a", title: "Before", content: null, metadata: null, icon: null, storageProvider: "GEODE", contentRef: "{}", revision: "rev-a", updatedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01") }
const opts = { operationId: "00000000-0000-4000-8000-000000000001", expectedRevision: "rev-a", authorName: "Alice", authorId: "alice" }

describe("immutable document service", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.$transaction.mockImplementation(async (fn) => fn(mocks.db))
    mocks.db.doc.findUnique.mockResolvedValue({ ...current })
    mocks.db.doc.findFirst.mockResolvedValue({ ...current })
    mocks.db.doc.updateMany.mockResolvedValue({ count: 1 })
    mocks.db.docOperation.findUnique.mockResolvedValue(null)
    mocks.db.docVersion.findFirst.mockResolvedValue(null)
    mocks.db.docVersion.create.mockResolvedValue({ id: "version-a" })
    mocks.putContent.mockResolvedValue({ status: "ok", reference: { version: 1, namespace: "workspace-a", digest: "abc", byteLength: 5 } })
    mocks.readContent.mockResolvedValue({ status: "ok", text: "hello" })
  })

  it("uploads before the atomic pointer, history and receipt transaction", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    await updateDocument("doc-a", { content: "hello" }, opts)
    expect(mocks.putContent.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.$transaction.mock.invocationCallOrder[0])
    expect(mocks.db.doc.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "doc-a", workspaceId: "workspace-a", revision: "rev-a" }, data: expect.objectContaining({ content: null, contentRef: expect.any(String), revision: expect.any(String) }) }))
    expect(mocks.db.docVersion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ contentRef: "{}", storageProvider: "GEODE" }) }))
    expect(mocks.db.docOperation.create).toHaveBeenCalledOnce()
  })

  it("rejects stale revisions before upload", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    await expect(updateDocument("doc-a", { content: "hello" }, { ...opts, expectedRevision: "old" })).rejects.toThrow("conflict")
    expect(mocks.putContent).not.toHaveBeenCalled()
  })

  it("does not change the pointer or history when object upload fails", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.putContent.mockResolvedValue({ status: "unavailable" })
    await expect(updateDocument("doc-a", { content: "hello" }, opts)).rejects.toThrow("unavailable")
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })

  it("detects a concurrent revision change inside the transaction", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.db.doc.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateDocument("doc-a", { title: "after" }, opts)).rejects.toThrow("conflict")
    expect(mocks.db.docOperation.create).not.toHaveBeenCalled()
  })

  it("replays a committed operation before rejecting its now stale revision", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    await updateDocument("doc-a", { title: "after" }, opts)
    const receipt = mocks.db.docOperation.create.mock.calls[0][0].data
    mocks.db.docOperation.findUnique.mockResolvedValue(receipt)
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, revision: "newer" })
    mocks.db.$transaction.mockClear()
    await updateDocument("doc-a", { title: "after" }, opts)
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
    await expect(updateDocument("doc-a", { title: "different" }, opts)).rejects.toThrow("operation")
  })

  it("never treats an unavailable stored body as empty content", async () => {
    const { hydrateDocument } = await import("@/lib/document-service")
    mocks.readContent.mockResolvedValue({ status: "missing" })
    await expect(hydrateDocument("workspace-a", current)).rejects.toThrow("missing")
  })

  it("hydrates exact stored bytes and removes private references", async () => {
    const { hydrateDocument } = await import("@/lib/document-service")
    mocks.readContent.mockResolvedValue({ status: "ok", text: "\uFEFF  hello\n" })
    const result = await hydrateDocument("workspace-a", current)
    expect(result.content).toBe("\uFEFF  hello\n")
    expect(result).not.toHaveProperty("contentRef")
  })

  it("enforces revisions and records replay receipts for database-backed documents", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    const databaseDoc = { ...current, storageProvider: null, contentRef: null, content: "old", revision: "rev-a" }
    mocks.db.doc.findUnique.mockResolvedValue(databaseDoc)
    await updateDocument("doc-a", { content: "new" }, opts)
    expect(mocks.putContent).not.toHaveBeenCalled()
    expect(mocks.db.doc.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "doc-a", workspaceId: "workspace-a", revision: "rev-a" }, data: expect.objectContaining({ content: "new", revision: expect.any(String) }) }))
    expect(mocks.db.docOperation.create).toHaveBeenCalledOnce()
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    mocks.db.$transaction.mockClear()
    await updateDocument("doc-a", { content: "new" }, opts)
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })

  it("rejects stale database-backed revisions before writing", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, storageProvider: null, contentRef: null, content: "old", revision: "rev-new" })
    await expect(updateDocument("doc-a", { content: "new" }, opts)).rejects.toThrow("revision-conflict")
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })

  it("keeps browser compatibility writes working while rotating the public revision", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, storageProvider: null, contentRef: null, content: "old", revision: "rev-a" })
    mocks.db.doc.update.mockResolvedValue({ ...current, storageProvider: null, content: "new", revision: "rev-b" })
    await updateDocument("doc-a", { content: "new" }, { authorName: "Alice" })
    expect(mocks.db.doc.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: "new", revision: expect.any(String) }) }))
    expect(mocks.db.docOperation.create).not.toHaveBeenCalled()
  })

  it("accepts the deterministic legacy token once and promotes a null revision", async () => {
    const { documentRevision, updateDocument } = await import("@/lib/document-service")
    const legacy = { ...current, storageProvider: null, contentRef: null, content: "old", revision: null, updatedAt: new Date("2026-01-01T00:00:00.000Z") }
    mocks.db.doc.findUnique.mockResolvedValue(legacy)
    const legacyOpts = { ...opts, expectedRevision: documentRevision(legacy) }
    await updateDocument("doc-a", { title: "new" }, legacyOpts)
    expect(mocks.db.doc.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ revision: null, updatedAt: legacy.updatedAt }),
      data: expect.objectContaining({ revision: expect.any(String) }),
    }))
  })

  it("creates database-backed documents with a revision and durable replay receipt", async () => {
    const { createDocument } = await import("@/lib/document-service")
    mocks.db.doc.create.mockImplementation(async ({ data }) => ({ ...current, ...data, storageProvider: null }))
    await createDocument({ workspaceId: "workspace-b", title: "Database" }, { ...opts, expectedRevision: undefined })
    expect(mocks.putContent).not.toHaveBeenCalled()
    expect(mocks.db.doc.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revision: expect.any(String) }) }))
    expect(mocks.db.docOperation.create).toHaveBeenCalledOnce()
  })

  it("guards and replays database-backed named snapshots", async () => {
    const { snapshotDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, storageProvider: null, contentRef: null })
    await snapshotDocument("doc-a", { ...opts, label: "Named" })
    expect(mocks.db.doc.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ revision: "rev-a" }) }))
    expect(mocks.db.docVersion.create).toHaveBeenCalledOnce()
    expect(mocks.db.docOperation.create).toHaveBeenCalledOnce()
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    mocks.db.$transaction.mockClear()
    await snapshotDocument("doc-a", { ...opts, label: "Named" })
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })

  it("rejects invalid canvas content before any write on legacy and pilot documents, and canonicalizes valid content", async () => {
    const { updateDocument, createDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, docType: "CANVAS", storageProvider: null, contentRef: null, content: "{}", revision: "rev-a" })
    await expect(updateDocument("doc-a", { content: "not json" }, opts)).rejects.toThrow("invalid-canvas")
    expect(mocks.db.doc.update).not.toHaveBeenCalled()
    mocks.db.doc.update.mockResolvedValue(current)
    await updateDocument("doc-a", { content: '{"nodes":[],"edges":[],"x":1}' }, opts)
    expect(mocks.db.doc.updateMany.mock.calls[0][0].data.content).toBe('{\n\t"nodes": [],\n\t"edges": [],\n\t"x": 1\n}')
    // Non-canvas content is untouched by the canvas gate.
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, docType: "STANDARD", storageProvider: null, contentRef: null, revision: "rev-a" })
    await updateDocument("doc-a", { content: "not json" }, opts)
    expect(mocks.db.doc.updateMany.mock.calls[1][0].data.content).toBe("not json")
    await expect(createDocument({ workspaceId: "ws-legacy", title: "c", docType: "CANVAS", content: "[]" }, opts)).rejects.toThrow("invalid-canvas")
    expect(mocks.db.doc.create).not.toHaveBeenCalled()
  })

  it("replays create despite sibling reordering and refuses changed payload or actor", async () => {
    const { createDocument } = await import("@/lib/document-service")
    mocks.db.doc.create.mockResolvedValue(current)
    await createDocument({ workspaceId: "workspace-a", title: "title", content: "hello", sortOrder: 1 }, opts)
    const receipt = mocks.db.docOperation.create.mock.calls[0][0].data
    mocks.db.docOperation.findUnique.mockResolvedValue(receipt)
    mocks.putContent.mockClear()
    await createDocument({ workspaceId: "workspace-a", title: "title", content: "hello", sortOrder: 2 }, opts)
    expect(mocks.putContent).not.toHaveBeenCalled()
    await expect(createDocument({ workspaceId: "workspace-a", title: "changed", content: "hello" }, opts)).rejects.toThrow("operation-conflict")
    await expect(createDocument({ workspaceId: "workspace-a", title: "title", content: "hello" }, { ...opts, actorKey: "another" })).rejects.toThrow("operation-conflict")
  })

  it("keeps date-like keys in user metadata untouched during replay", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, metadata: { createdAt: "not a date", updatedAt: "2026-01-01" } })
    await updateDocument("doc-a", { title: "after" }, opts)
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    const result = await updateDocument("doc-a", { title: "after" }, opts)
    expect(result.metadata).toEqual({ createdAt: "not a date", updatedAt: "2026-01-01" })
    expect(result.updatedAt).toBeInstanceOf(Date)
  })
  it("distinguishes JSON null from an empty metadata object in replay payloads", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    await updateDocument("doc-a", { metadata: Prisma.JsonNull }, opts)
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    await expect(updateDocument("doc-a", { metadata: {} }, opts)).rejects.toThrow("operation-conflict")
  })

  it("rejects malformed operation IDs before external storage", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    await expect(updateDocument("doc-a", { content: "hello" }, { ...opts, operationId: "-".repeat(36) })).rejects.toThrow("operation-id-required")
    expect(mocks.putContent).not.toHaveBeenCalled()
  })

  it("replays restored content without storage access after a lost response", async () => {
    const { restoreDocument } = await import("@/lib/document-service")
    mocks.db.docVersion.findUnique.mockResolvedValue({ ...current, docId: "doc-a", id: "version-a" })
    await restoreDocument("version-a", opts)
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    mocks.readContent.mockClear()
    mocks.putContent.mockClear()
    await restoreDocument("version-a", opts)
    expect(mocks.readContent).not.toHaveBeenCalled()
    expect(mocks.putContent).not.toHaveBeenCalled()
  })

  it("replays deletion after the doc is gone and rejects a changed actor", async () => {
    const { deleteDocument } = await import("@/lib/document-service")
    mocks.db.doc.findFirst.mockResolvedValue(null)
    await deleteDocument("doc-a", opts)
    mocks.db.docOperation.findUnique.mockResolvedValue(mocks.db.docOperation.create.mock.calls[0][0].data)
    mocks.db.doc.findUnique.mockResolvedValue(null)
    await expect(deleteDocument("doc-a", { ...opts, workspaceId: "workspace-a" })).resolves.toBeUndefined()
    await expect(deleteDocument("doc-a", { ...opts, workspaceId: "workspace-a", authorId: "other" })).rejects.toThrow("operation-conflict")
  })
})
