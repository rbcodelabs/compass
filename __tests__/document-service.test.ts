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

  it("keeps legacy documents database-backed and compatible without revision inputs", async () => {
    const { updateDocument } = await import("@/lib/document-service")
    mocks.db.doc.findUnique.mockResolvedValue({ ...current, storageProvider: null, contentRef: null, content: "old", revision: null })
    mocks.db.doc.update.mockResolvedValue({ ...current, content: "new" })
    await updateDocument("doc-a", { content: "new" }, { authorName: "Alice" })
    expect(mocks.putContent).not.toHaveBeenCalled()
    expect(mocks.db.doc.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: "new" }) }))
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
