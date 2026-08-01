import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTask = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const mockTaskLink = {
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

const mockPrisma = {
  task: mockTask,
  taskLink: mockTaskLink,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
  it("updates the sort order directly and bumps updatedAt", async () => {
    await updateSortOrder("task-1", 9, "/path");
    const call = mockTask.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "task-1" });
    expect(call.data.sortOrder).toBe(9);
    expect(call.data.updatedAt).toBeInstanceOf(Date);
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
