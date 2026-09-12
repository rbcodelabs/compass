// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  moveTaskStatus: vi.fn(),
  updateSortOrder: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  addTask: vi.fn(),
  getTaskAssigneeOptions: vi.fn().mockResolvedValue([]),
}));

import { TaskBoard, taskSetSignature } from "@/components/tasks/task-board";
import type { TaskCardData } from "@/components/tasks/task-card";

function task(overrides: Partial<TaskCardData> & Pick<TaskCardData, "id" | "title">): TaskCardData {
  return {
    description: null,
    status: "TODO",
    priority: "MEDIUM",
    sortOrder: 0,
    squadId: null,
    squad: null,
    assigneeUserId: null,
    assigneeAgentId: null,
    assignee: null,
    ownerName: null,
    storyPoints: null,
    dueDate: null,
    iteration: null,
    parentTaskId: null,
    subtaskCount: 0,
    links: [],
    ...overrides,
  };
}

function renderBoard(initialTasks: TaskCardData[]) {
  return render(
    <TaskBoard
      initialTasks={initialTasks}
      workspaceId="ws-1"
      orgSlug="rbcodelabs"
      workspaceSlug="compass"
      members={[]}
    />
  );
}

const alice = task({ id: "t-alice", title: "Alice task", assigneeUserId: "user-alice" });
const bob = task({ id: "t-bob", title: "Bob task", assigneeUserId: "user-bob", sortOrder: 1 });

describe("taskSetSignature", () => {
  it("is stable across reordering and per-task field changes", () => {
    // A drag only changes status/sortOrder, and the optimistic board state is
    // already correct — resyncing on those would clobber or visibly revert it.
    const moved = [{ ...bob, status: "DONE" as const, sortOrder: 7 }, alice];
    expect(taskSetSignature(moved)).toBe(taskSetSignature([alice, bob]));
  });

  it("changes when the server-provided task set gains or loses a task", () => {
    expect(taskSetSignature([alice])).not.toBe(taskSetSignature([alice, bob]));
    expect(taskSetSignature([])).not.toBe(taskSetSignature([alice]));
  });
});

describe("TaskBoard resync with server-filtered tasks", () => {
  afterEach(() => cleanup());

  it("narrows the board when a filter change re-renders the page with fewer tasks", () => {
    const { rerender } = renderBoard([alice, bob]);
    expect(screen.getByText("Alice task")).toBeVisible();
    expect(screen.getByText("Bob task")).toBeVisible();

    // What the server does on `?assignee=user-alice`: same client instance, new props.
    rerender(
      <TaskBoard
        initialTasks={[alice]}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    );

    expect(screen.getByText("Alice task")).toBeVisible();
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();
  });

  it("widens the board again when the filter is cleared", () => {
    const { rerender } = renderBoard([alice]);
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();

    rerender(
      <TaskBoard
        initialTasks={[alice, bob]}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    );

    expect(screen.getByText("Bob task")).toBeVisible();
  });

  it("shows an emptied board when a filter matches nothing", () => {
    const { rerender } = renderBoard([alice, bob]);

    rerender(
      <TaskBoard
        initialTasks={[]}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    );

    expect(screen.queryByText("Alice task")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();
  });

  it("does not revert an optimistic status move when revalidation re-sends the same task set", async () => {
    const { rerender } = renderBoard([alice, bob]);
    const todoColumn = () => document.querySelector<HTMLElement>('[data-task-column="TODO"]')!;
    expect(todoColumn().textContent).toContain("Alice task");

    // Drive a real optimistic column move through the card menu. This is the
    // same setColumns path drag-and-drop uses: the client moves the task
    // immediately, and the server props still describe the pre-move state.
    fireEvent.click(within(todoColumn()).getAllByRole("button", { name: "Card actions" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cancel" }));
    expect(todoColumn().textContent).not.toContain("Alice task");
    expect(screen.getByRole("button", { name: /Show cancelled \(1\)/ })).toBeVisible();

    // Revalidation lands carrying the same identity set (the task was moved,
    // not created or deleted). The board must leave the optimistic state alone.
    rerender(
      <TaskBoard
        initialTasks={[alice, bob]}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    );

    expect(todoColumn().textContent).not.toContain("Alice task");
    expect(screen.getByRole("button", { name: /Show cancelled \(1\)/ })).toBeVisible();
  });
});
