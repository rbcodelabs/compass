import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDoc = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockDocVersion = {
  deleteMany: vi.fn(),
  findUnique: vi.fn(),
};

const mockPrisma = {
  doc: mockDoc,
  docVersion: mockDocVersion,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mock auth — these actions gate on a valid session
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// Doc versioning logic (coalescing, restore) has its own dedicated unit
// tests in __tests__/lib/doc-versions.test.ts — here we only assert that
// the server actions call it with the right arguments at the right time.
const mockMaybeSnapshotDocVersion = vi.fn();
const mockRestoreDocVersionCore = vi.fn();
vi.mock("@/lib/doc-versions", () => ({
  maybeSnapshotDocVersion: (...args: unknown[]) => mockMaybeSnapshotDocVersion(...args),
  restoreDocVersionCore: (...args: unknown[]) => mockRestoreDocVersionCore(...args),
}));

import { auth } from "@/auth";
import {
  createDoc,
  updateDoc,
  createDocVersion,
  getDocVersionContent,
  restoreDocVersion,
  deleteDoc,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

const mockAuth = vi.mocked(auth);

const SESSION = { user: { id: "user-1", name: "Dev User", email: "dev@example.com" } } as ReturnType<
  typeof auth
> extends Promise<infer T>
  ? T
  : never;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated session
  mockAuth.mockResolvedValue(SESSION);
  mockDoc.create.mockResolvedValue({ id: "doc-1", title: "Untitled" });
  mockDoc.update.mockResolvedValue({ id: "doc-1" });
  mockDoc.delete.mockResolvedValue({ id: "doc-1" });
  mockDocVersion.deleteMany.mockResolvedValue({ count: 0 });
  mockMaybeSnapshotDocVersion.mockResolvedValue(undefined);
  mockRestoreDocVersionCore.mockResolvedValue({
    id: "doc-1",
    title: "Restored Title",
    docId: "doc-1",
    restoredFrom: new Date("2026-07-01T00:00:00Z"),
  });
});

// ─── createDoc ───────────────────────────────────────────────────────────────

describe("createDoc", () => {
  it("creates a doc with title Untitled and returns it", async () => {
    const result = await createDoc("ws-1", null, "/path");
    expect(mockDoc.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", parentId: null, title: "Untitled" },
    });
    expect(result).toMatchObject({ id: "doc-1", title: "Untitled" });
  });

  it("passes through a parentId when provided", async () => {
    await createDoc("ws-1", "parent-doc-1", "/path");
    const data = mockDoc.create.mock.calls[0][0].data;
    expect(data.parentId).toBe("parent-doc-1");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(createDoc("ws-1", null, "/path")).rejects.toThrow("Unauthorized");
  });

  it("throws Unauthorized when session has no user id", async () => {
    mockAuth.mockResolvedValue({ user: {} } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    await expect(createDoc("ws-1", null, "/path")).rejects.toThrow("Unauthorized");
  });

  it("propagates DB errors", async () => {
    mockDoc.create.mockRejectedValue(new Error("DB constraint"));
    await expect(createDoc("ws-1", null, "/path")).rejects.toThrow("DB constraint");
  });
});

// ─── updateDoc ────────────────────────────────────────────────────────────────

describe("updateDoc", () => {
  it("updates a doc with title, content, and icon", async () => {
    await updateDoc("doc-1", { title: "My Doc", content: "Hello", icon: "📝" }, "/path");
    const callArgs = mockDoc.update.mock.calls[0][0];
    expect(callArgs.where).toEqual({ id: "doc-1" });
    expect(callArgs.data.title).toBe("My Doc");
    expect(callArgs.data.content).toBe("Hello");
    expect(callArgs.data.icon).toBe("📝");
    expect(callArgs.data.updatedAt).toBeInstanceOf(Date);
  });

  it("updates only provided fields", async () => {
    await updateDoc("doc-1", { title: "New Title" }, "/path");
    const data = mockDoc.update.mock.calls[0][0].data;
    expect(data.title).toBe("New Title");
    expect(data.content).toBeUndefined();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      updateDoc("doc-1", { title: "Hacked" }, "/path")
    ).rejects.toThrow("Unauthorized");
    expect(mockDoc.update).not.toHaveBeenCalled();
  });

  it("propagates DB errors", async () => {
    mockDoc.update.mockRejectedValue(new Error("not found"));
    await expect(
      updateDoc("doc-999", { title: "X" }, "/path")
    ).rejects.toThrow("not found");
  });

  it("snapshots the doc's pre-change state, using the session's user id and name, before a real change", async () => {
    await updateDoc("doc-1", { title: "New Title" }, "/path");

    expect(mockMaybeSnapshotDocVersion).toHaveBeenCalledWith("doc-1", {
      authorId: "user-1",
      authorName: "Dev User",
    });
    // Snapshot happens before the overwrite, not after.
    const snapshotOrder = mockMaybeSnapshotDocVersion.mock.invocationCallOrder[0];
    const updateOrder = mockDoc.update.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(updateOrder);
  });

  it("falls back to the session email when the user has no name", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", name: null, email: "dev@example.com" },
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    await updateDoc("doc-1", { content: "Hello" }, "/path");

    expect(mockMaybeSnapshotDocVersion).toHaveBeenCalledWith("doc-1", {
      authorId: "user-1",
      authorName: "dev@example.com",
    });
  });

  it("does not snapshot on a no-op call (no title/content/icon provided)", async () => {
    await updateDoc("doc-1", {}, "/path");
    expect(mockMaybeSnapshotDocVersion).not.toHaveBeenCalled();
  });
});

// ─── createDocVersion (manual named snapshot) ─────────────────────────────────

describe("createDocVersion", () => {
  it("snapshots with the trimmed label and the session's identity", async () => {
    await createDocVersion("doc-1", "  Before big rewrite  ", "/path");

    expect(mockMaybeSnapshotDocVersion).toHaveBeenCalledWith("doc-1", {
      authorId: "user-1",
      authorName: "Dev User",
      label: "Before big rewrite",
    });
  });

  it("defaults the label to 'Snapshot' when none is given", async () => {
    await createDocVersion("doc-1", undefined, "/path");

    const opts = mockMaybeSnapshotDocVersion.mock.calls[0][1];
    expect(opts.label).toBe("Snapshot");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(createDocVersion("doc-1", "Label", "/path")).rejects.toThrow("Unauthorized");
    expect(mockMaybeSnapshotDocVersion).not.toHaveBeenCalled();
  });
});

// ─── getDocVersionContent ──────────────────────────────────────────────────────

describe("getDocVersionContent", () => {
  it("returns the version's full content", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce({
      id: "version-1",
      title: "Old Title",
      content: "Old content",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      label: null,
      createdByName: "Dev User",
    });

    const result = await getDocVersionContent("version-1");
    expect(result.content).toBe("Old content");
    expect(mockDocVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "version-1" } })
    );
  });

  it("throws when the version does not exist", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce(null);
    await expect(getDocVersionContent("missing")).rejects.toThrow("Version not found");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(getDocVersionContent("version-1")).rejects.toThrow("Unauthorized");
  });
});

// ─── restoreDocVersion ──────────────────────────────────────────────────────────

describe("restoreDocVersion", () => {
  it("restores via restoreDocVersionCore with the session's identity", async () => {
    const result = await restoreDocVersion("version-1", "/path");

    expect(mockRestoreDocVersionCore).toHaveBeenCalledWith("version-1", {
      authorId: "user-1",
      authorName: "Dev User",
    });
    expect(result.title).toBe("Restored Title");
  });

  it("throws when the version does not exist", async () => {
    mockRestoreDocVersionCore.mockResolvedValueOnce(null);
    await expect(restoreDocVersion("missing", "/path")).rejects.toThrow("Version not found");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(restoreDocVersion("version-1", "/path")).rejects.toThrow("Unauthorized");
    expect(mockRestoreDocVersionCore).not.toHaveBeenCalled();
  });
});

// ─── deleteDoc ────────────────────────────────────────────────────────────────

describe("deleteDoc", () => {
  it("deletes the doc by id", async () => {
    await deleteDoc("doc-1", "/path");
    expect(mockDoc.delete).toHaveBeenCalledWith({ where: { id: "doc-1" } });
  });

  it("deletes DocVersion rows for the doc before deleting the doc itself (no FK cascade on DSQL)", async () => {
    await deleteDoc("doc-1", "/path");

    expect(mockDocVersion.deleteMany).toHaveBeenCalledWith({ where: { docId: "doc-1" } });
    const deleteVersionsOrder = mockDocVersion.deleteMany.mock.invocationCallOrder[0];
    const deleteDocOrder = mockDoc.delete.mock.invocationCallOrder[0];
    expect(deleteVersionsOrder).toBeLessThan(deleteDocOrder);
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(deleteDoc("doc-1", "/path")).rejects.toThrow("Unauthorized");
    expect(mockDoc.delete).not.toHaveBeenCalled();
    expect(mockDocVersion.deleteMany).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when user id is absent", async () => {
    mockAuth.mockResolvedValue({ user: {} } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    await expect(deleteDoc("doc-1", "/path")).rejects.toThrow("Unauthorized");
  });

  it("propagates DB errors", async () => {
    mockDoc.delete.mockRejectedValue(new Error("record not found"));
    await expect(deleteDoc("doc-999", "/path")).rejects.toThrow("record not found");
  });
});
