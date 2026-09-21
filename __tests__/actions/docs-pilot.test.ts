import { beforeEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), doc: vi.fn(), version: vi.fn(), comment: vi.fn(), update: vi.fn(), create: vi.fn(), hydrate: vi.fn(), remove: vi.fn(), snapshot: vi.fn(), restore: vi.fn() }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: m.workspace }, doc: { findUnique: m.doc, update: m.update, create: m.create }, docVersion: { findUnique: m.version }, docComment: { findUnique: m.comment } }) }))
vi.mock("@/lib/doc-versions", () => ({ maybeSnapshotDocVersion: vi.fn(), restoreDocVersionCore: vi.fn() }))
vi.mock("@/lib/doc-comments", () => ({ listDocCommentsCore: vi.fn().mockResolvedValue([]), createDocCommentCore: vi.fn(), setDocCommentStatusCore: vi.fn(), deleteDocCommentCore: vi.fn() }))
vi.mock("@/lib/document-service", () => ({ updateDocument: m.update, createDocument: m.create, hydrateDocument: m.hydrate, deleteDocument: m.remove, snapshotDocument: m.snapshot, restoreDocument: m.restore }))
import { updateDoc, createDoc, getDocVersionContent, listDocComments } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ user: { id: "user", name: "User" } }); m.workspace.mockResolvedValue({ id: "workspace" }); m.doc.mockResolvedValue({ id: "doc", workspaceId: "workspace" }); m.update.mockResolvedValue({ id: "doc", revision: "r2", contentRef: "PRIVATE" }); m.create.mockResolvedValue({ id: "doc", revision: "r1", contentRef: "PRIVATE" }) })
it("rejects another workspace before invoking a document mutation", async () => {
  m.workspace.mockResolvedValue(null)
  await expect(updateDoc("doc", { content: "draft" }, "/docs")).rejects.toThrow("access denied")
  expect(m.update).not.toHaveBeenCalled()
})
it("passes the observed revision and stable operation ID and does not expose storage references", async () => {
  const result = await updateDoc("doc", { content: "draft" }, "/docs", { expectedRevision: "r1", operationId: "operation" })
  expect(m.update).toHaveBeenCalledWith("doc", { content: "draft" }, expect.objectContaining({ expectedRevision: "r1", operationId: "operation", authorId: "user" }))
  expect(result).toEqual({ id: "doc", revision: "r2" })
})
it("authorizes creation before invoking storage", async () => {
  m.workspace.mockResolvedValue(null)
  await expect(createDoc("workspace", null, "/docs")).rejects.toThrow("access denied")
  expect(m.create).not.toHaveBeenCalled()
})
it("hydrates historical content only after authorizing its actual document workspace", async () => {
  m.version.mockResolvedValue({ id: "version", docId: "doc", content: null, storageProvider: "GEODE", contentRef: "private" })
  m.workspace.mockResolvedValue(null)
  await expect(getDocVersionContent("version")).rejects.toThrow("access denied")
  expect(m.hydrate).not.toHaveBeenCalled()
})
it("checks membership before listing document comments", async () => {
  m.workspace.mockResolvedValue(null)
  await expect(listDocComments("doc")).rejects.toThrow("access denied")
})
it("does not forward runtime-injected internal receipt or ownership fields", async () => {
  const mutation = { expectedRevision: "r1", operationId: "op", receiptDigest: "attacker", actorKey: "other", restoreVersionId: "other" }
  const change = { content: "body", workspaceId: "other", storageProvider: "DATABASE", parentId: "other" }
  await updateDoc("doc", change, "/docs", mutation)
  expect(m.update.mock.calls[0][1]).toEqual({ content: "body" })
  expect(m.update.mock.calls[0][2]).toEqual({ expectedRevision: "r1", operationId: "op", authorId: "user", authorName: "User" })
})
