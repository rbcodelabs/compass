import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDoc = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockPrisma = {
  doc: mockDoc,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mock auth — these actions gate on a valid session
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { createDoc, updateDoc, deleteDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated session
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockDoc.create.mockResolvedValue({ id: "doc-1", title: "Untitled" });
  mockDoc.update.mockResolvedValue({ id: "doc-1" });
  mockDoc.delete.mockResolvedValue({ id: "doc-1" });
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
});

// ─── deleteDoc ────────────────────────────────────────────────────────────────

describe("deleteDoc", () => {
  it("deletes the doc by id", async () => {
    await deleteDoc("doc-1", "/path");
    expect(mockDoc.delete).toHaveBeenCalledWith({ where: { id: "doc-1" } });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(deleteDoc("doc-1", "/path")).rejects.toThrow("Unauthorized");
    expect(mockDoc.delete).not.toHaveBeenCalled();
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
