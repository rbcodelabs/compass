import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTask = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockTaskLink = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

const mockPrisma = {
  $transaction: vi.fn(async (callback: (tx: { task: typeof mockTask }) => unknown) => callback(mockPrisma)),
  workspaceMember: { findFirst: vi.fn() },
  opportunity: { findFirst: vi.fn() },
  task: mockTask,
  taskLink: mockTaskLink,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

import {
  addTask,
  updateTask,
  moveTaskStatus,
  updateSortOrder,
  cancelTask,
  linkTask,
  unlinkTask,
} from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ id: "membership" });
  mockPrisma.opportunity.findFirst.mockResolvedValue({ id: "opp-1" });
  mockTask.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
  mockTask.findMany.mockResolvedValue([]);
  mockTaskLink.findUnique.mockResolvedValue({ taskId: "task-1" });
  mockTask.create.mockResolvedValue({ id: "task-1", title: "Test Task", status: "TODO" });
  mockTask.update.mockResolvedValue({ id: "task-1" });
  mockTask.findFirst.mockResolvedValue(null);
  mockTaskLink.findFirst.mockResolvedValue(null);
  mockTaskLink.create.mockResolvedValue({ id: "link-1" });
});

// ─── addTask ──────────────────────────────────────────────────────────────────

describe("addTask", () => {
  it("creates a task at sortOrder 0 when the status column is empty", async () => {
    const result = await addTask("ws-1", { title: "Ship payments" }, "/path");
    const data = mockTask.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(0);
    expect(data.status).toBe("TODO");
    expect(data.title).toBe("Ship payments");
    expect(result).toMatchObject({ id: "task-1" });
  });

  it("places task after the last item in the status column", async () => {
    mockTask.findFirst.mockResolvedValue({ sortOrder: 4 });
    await addTask("ws-1", { title: "Feature X", status: "IN_PROGRESS" }, "/path");
    const data = mockTask.create.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(5);
  });

  it("defaults priority to MEDIUM", async () => {
    await addTask("ws-1", { title: "Feature Y" }, "/path");
    const data = mockTask.create.mock.calls[0][0].data;
    expect(data.priority).toBe("MEDIUM");
  });

  it("passes through parentTaskId to create a subtask", async () => {
    mockTask.findFirst.mockResolvedValueOnce({ id: "epic-1" });
    await addTask("ws-1", { title: "Subtask", parentTaskId: "epic-1" }, "/path");
    const data = mockTask.create.mock.calls[0][0].data;
    expect(data.parentTaskId).toBe("epic-1");
  });

  it("passes through assignee, owner name, story points, due date", async () => {
    const dueDate = new Date("2026-08-15");
    await addTask(
      "ws-1",
      { title: "Z", assigneeUserId: "user-1", ownerName: "Jane", storyPoints: 5, dueDate },
      "/path"
    );
    const data = mockTask.create.mock.calls[0][0].data;
    expect(data.assigneeUserId).toBe("user-1");
    expect(data.ownerName).toBe("Jane");
    expect(data.storyPoints).toBe(5);
    expect(data.dueDate).toBe(dueDate);
  });

  it("propagates DB errors", async () => {
    mockTask.create.mockRejectedValue(new Error("DB error"));
    await expect(addTask("ws-1", { title: "Fail" }, "/path")).rejects.toThrow("DB error");
  });
});

describe("task action authorization", () => {
  it("rejects unauthenticated writes before looking up tasks", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(updateTask("task-1", { title: "no" }, "/path")).rejects.toThrow("Unauthorized");
    expect(mockTask.findUnique).not.toHaveBeenCalled();
    expect(mockTask.update).not.toHaveBeenCalled();
  });
  it("rejects direct action calls by nonmembers", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(cancelTask("task-1", "/path")).rejects.toThrow("Not found");
    expect(mockTask.update).not.toHaveBeenCalled();
  });
  it("cannot move a task through a different workspace", async () => {
    await expect(moveTaskStatus("task-1", "DONE", "foreign", "/path")).rejects.toThrow("Not found");
    expect(mockTask.update).not.toHaveBeenCalled();
  });
  it("denies cross-workspace links", async () => {
    mockPrisma.opportunity.findFirst.mockResolvedValue(null);
    await expect(linkTask("task-1", "OPPORTUNITY", "foreign", "/path")).rejects.toThrow("different workspace");
    expect(mockTaskLink.create).not.toHaveBeenCalled();
  });
  it("legacy clear removes an agent assignment too", async () => {
    await updateTask("task-1", { assigneeUserId: null }, "/path");
    expect(mockTask.update.mock.calls[0][0].data).toMatchObject({ assigneeUserId: null, assigneeAgentId: null });
  });
});

// ─── updateTask ───────────────────────────────────────────────────────────────

describe("updateTask", () => {
  it("updates only the provided fields and always sets updatedAt explicitly", async () => {
    await updateTask("task-1", { title: "Renamed", storyPoints: 8 }, "/path");
    const call = mockTask.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "task-1" });
    expect(call.data.title).toBe("Renamed");
    expect(call.data.storyPoints).toBe(8);
    expect(call.data.description).toBeUndefined();
    expect(call.data.updatedAt).toBeInstanceOf(Date);
  });

  it("clears a field when explicitly passed null", async () => {
    await updateTask("task-1", { assigneeUserId: null, dueDate: null }, "/path");
    const call = mockTask.update.mock.calls[0][0];
    expect(call.data.assigneeUserId).toBeNull();
    expect(call.data.dueDate).toBeNull();
  });

  it("propagates DB errors for a missing task id", async () => {
    mockTask.update.mockRejectedValue(new Error("Record to update not found"));
    await expect(updateTask("missing", { title: "X" }, "/path")).rejects.toThrow(
      "Record to update not found"
    );
  });
});

// ─── moveTaskStatus ───────────────────────────────────────────────────────────

describe("moveTaskStatus", () => {
  it("changes status and places at sortOrder 0 when destination is empty", async () => {
    mockTask.findFirst.mockResolvedValue(null);
    await moveTaskStatus("task-1", "BLOCKED", "ws-1", "/path");
    const data = mockTask.update.mock.calls[0][0].data;
    expect(data.status).toBe("BLOCKED");
    expect(data.sortOrder).toBe(0);
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  it("places task after the last existing item in the destination column", async () => {
    mockTask.findFirst.mockResolvedValue({ sortOrder: 7 });
    await moveTaskStatus("task-1", "IN_REVIEW", "ws-1", "/path");
    const data = mockTask.update.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(8);
  });

  it("excludes the task itself from the destination-column max lookup", async () => {
    await moveTaskStatus("task-1", "DONE", "ws-1", "/path");
    const where = mockTask.findFirst.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ id: "task-1" });
  });

  it("moves a task into BLOCKED as a first-class status", async () => {
    await moveTaskStatus("task-1", "BLOCKED", "ws-1", "/path");
    const data = mockTask.update.mock.calls[0][0].data;
    expect(data.status).toBe("BLOCKED");
  });
});

// ─── updateSortOrder ──────────────────────────────────────────────────────────

describe("updateSortOrder", () => {
  it("renumbers the full status column while preserving hidden task positions", async () => {
    mockTask.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO" });
    mockTask.findMany.mockResolvedValue([
      { id: "task-1", sortOrder: 0 },
      { id: "hidden-task", sortOrder: 0 },
      { id: "task-2", sortOrder: 2 },
    ]);

    await updateSortOrder("task-1", ["task-2", "task-1"], "/path");

    expect(mockTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", status: "TODO" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sortOrder: true },
    });
    expect(mockTask.update.mock.calls.map(([call]) => call)).toEqual([
      { where: { id: "task-2" }, data: { sortOrder: 0, updatedAt: expect.any(Date) } },
      { where: { id: "hidden-task" }, data: { sortOrder: 1, updatedAt: expect.any(Date) } },
      { where: { id: "task-1" }, data: { sortOrder: 2, updatedAt: expect.any(Date) } },
    ]);
  });

  it("rejects reordered ids outside the authenticated task's status column", async () => {
    mockTask.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO" });
    mockTask.findMany.mockResolvedValue([{ id: "task-1", sortOrder: 0 }]);

    await expect(updateSortOrder("task-1", ["foreign-task", "task-1"], "/path"))
      .rejects.toThrow("Not found");

    expect(mockTask.update).not.toHaveBeenCalled();
  });
});

// ─── cancelTask ───────────────────────────────────────────────────────────────

describe("cancelTask", () => {
  it("sets status to CANCELLED", async () => {
    await cancelTask("task-1", "/path");
    const call = mockTask.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "task-1" });
    expect(call.data.status).toBe("CANCELLED");
    expect(call.data.updatedAt).toBeInstanceOf(Date);
  });

  it("propagates DB errors", async () => {
    mockTask.update.mockRejectedValue(new Error("not found"));
    await expect(cancelTask("task-999", "/path")).rejects.toThrow("not found");
  });
});

// ─── linkTask / unlinkTask ────────────────────────────────────────────────────

describe("linkTask", () => {
  it("creates a new link when none exists", async () => {
    await linkTask("task-1", "OPPORTUNITY", "opp-1", "/path");
    expect(mockTaskLink.create).toHaveBeenCalledWith({
      data: { taskId: "task-1", linkedType: "OPPORTUNITY", linkedId: "opp-1" },
    });
  });

  it("is idempotent — returns the existing link without creating a duplicate", async () => {
    mockTaskLink.findFirst.mockResolvedValue({ id: "existing-link" });
    const result = await linkTask("task-1", "OPPORTUNITY", "opp-1", "/path");
    expect(mockTaskLink.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "existing-link" });
  });
});

describe("unlinkTask", () => {
  it("deletes the link by id", async () => {
    await unlinkTask("link-1", "/path");
    expect(mockTaskLink.delete).toHaveBeenCalledWith({ where: { id: "link-1" } });
  });
});
