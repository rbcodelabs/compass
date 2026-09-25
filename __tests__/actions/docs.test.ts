import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), doc: vi.fn(), version: vi.fn(), create: vi.fn(), update: vi.fn(), snapshot: vi.fn(), restore: vi.fn(), remove: vi.fn(), hydrate: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: m.workspace }, doc: { findUnique: m.doc }, docVersion: { findUnique: m.version } }) }));
vi.mock("@/lib/document-service", () => ({ createDocument: m.create, updateDocument: m.update, snapshotDocument: m.snapshot, restoreDocument: m.restore, deleteDocument: m.remove, hydrateDocument: m.hydrate }));
import { createDoc, updateDoc, updateDocMetadata, createDocVersion, getDocVersionContent, restoreDocVersion, deleteDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", name: "Dev User", email: "dev@example.com" } });
  m.workspace.mockResolvedValue({ id: "ws-1" });
  m.doc.mockResolvedValue({ id: "doc-1", workspaceId: "ws-1" });
  m.version.mockResolvedValue({ id: "version-1", docId: "doc-1", title: "Old", content: "Old body" });
  m.create.mockResolvedValue({ id: "doc-1", title: "Untitled", revision: null });
  m.update.mockResolvedValue({ id: "doc-1", revision: "next" });
  m.restore.mockResolvedValue({ id: "doc-1", docId: "doc-1", title: "Restored", revision: "next" });
  m.hydrate.mockImplementation(async (_workspace, row) => row);
});
describe("document actions use the shared authorized service", () => {
  it("creates Untitled with the supplied parent and trusted actor", async () => {
    expect(await createDoc("ws-1", "parent", "/docs")).toMatchObject({ id: "doc-1", title: "Untitled" });
    expect(m.create).toHaveBeenCalledWith({ workspaceId: "ws-1", parentId: "parent", title: "Untitled" }, expect.objectContaining({ authorId: "user-1", authorName: "Dev User" }));
  });
  it("updates only supplied fields and delegates atomic snapshots to the service", async () => {
    await updateDoc("doc-1", { title: "New" }, "/docs");
    expect(m.update).toHaveBeenCalledWith("doc-1", { title: "New" }, expect.objectContaining({ authorId: "user-1" }));
    expect(m.snapshot).not.toHaveBeenCalled();
  });
  it("preserves a no-op change", async () => {
    await updateDoc("doc-1", {}, "/docs");
    expect(m.update).toHaveBeenCalledWith("doc-1", {}, expect.any(Object));
  });
  it("uses email when the user has no name", async () => {
    m.auth.mockResolvedValue({ user: { id: "user-1", email: "dev@example.com" } });
    await updateDoc("doc-1", { content: "Body" }, "/docs");
    expect(m.update).toHaveBeenCalledWith("doc-1", { content: "Body" }, expect.objectContaining({ authorName: "dev@example.com" }));
  });
  it("saves metadata through the same revision-aware service", async () => {
    await updateDocMetadata("doc-1", { tag: "x" }, "/docs", { expectedRevision: "old", operationId: "operation" });
    expect(m.update).toHaveBeenCalledWith("doc-1", { metadata: { tag: "x" } }, expect.objectContaining({ expectedRevision: "old", operationId: "operation" }));
  });
  it.each([["  Before rewrite  ", "Before rewrite"], [undefined, "Snapshot"]])("normalizes manual snapshot labels", async (input, expected) => {
    await createDocVersion("doc-1", input, "/docs");
    expect(m.snapshot).toHaveBeenCalledWith("doc-1", expect.objectContaining({ label: expected, authorId: "user-1" }));
  });
  it("hydrates historical content using its owning workspace", async () => {
    expect((await getDocVersionContent("version-1")).content).toBe("Old body");
    expect(m.hydrate).toHaveBeenCalledWith("ws-1", expect.objectContaining({ id: "version-1" }));
  });
  it("restores with the trusted actor and observed revision", async () => {
    expect((await restoreDocVersion("version-1", "/docs", { expectedRevision: "old", operationId: "operation" })).title).toBe("Restored");
    expect(m.restore).toHaveBeenCalledWith("version-1", expect.objectContaining({ expectedRevision: "old", authorId: "user-1" }));
  });
  it("delegates transactional deletion to the service", async () => {
    await deleteDoc("doc-1", "/docs");
    expect(m.remove).toHaveBeenCalledWith("doc-1", expect.objectContaining({ workspaceId: "ws-1", authorId: "user-1" }));
  });
  it("permits authorized deletion receipt replay after the document is gone", async () => {
    m.doc.mockResolvedValue(null);
    await deleteDoc("doc-1", "/docs", { workspaceId: "ws-1", operationId: "operation", expectedRevision: "old" });
    expect(m.remove).toHaveBeenCalled();
  });
  it("rejects delete with a substituted workspace", async () => {
    await expect(deleteDoc("doc-1", "/docs", { workspaceId: "other" })).rejects.toThrow("Document not found");
    expect(m.remove).not.toHaveBeenCalled();
  });
  it.each([() => createDoc("ws-1", null, "/docs"), () => updateDoc("doc-1", {}, "/docs"), () => createDocVersion("doc-1", undefined, "/docs"), () => getDocVersionContent("version-1"), () => restoreDocVersion("version-1", "/docs"), () => deleteDoc("doc-1", "/docs")])("rejects missing authentication", async action => {
    m.auth.mockResolvedValue(null);
    await expect(action()).rejects.toThrow("Unauthorized");
    expect(m.create).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
  });
  it("reports missing versions", async () => {
    m.version.mockResolvedValue(null);
    await expect(getDocVersionContent("missing")).rejects.toThrow("Version not found");
    await expect(restoreDocVersion("missing", "/docs")).rejects.toThrow("Version not found");
  });
  it("propagates storage/service errors", async () => {
    m.update.mockRejectedValue(new Error("storage unavailable"));
    await expect(updateDoc("doc-1", { content: "draft" }, "/docs")).rejects.toThrow("storage unavailable");
  });
});
