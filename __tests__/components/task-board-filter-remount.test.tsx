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

import { TaskBoard } from "@/components/tasks/task-board";
import { taskBoardFilterKey } from "@/lib/task-filters";
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

const alice = task({ id: "t-alice", title: "Alice task", assigneeUserId: "user-alice" });
const bob = task({ id: "t-bob", title: "Bob task", assigneeUserId: "user-bob", sortOrder: 1 });

type Filters = { squad?: string | null; assignee?: string | null; priority?: string | null };

/**
 * Mirrors how `tasks/page.tsx` mounts the board: the filter values become its
 * React `key`. Testing through this rather than rendering `TaskBoard` bare is
 * the point — the narrowing behaviour lives in the key, so a test that skips it
 * would not be exercising the real integration.
 */
function Page({ tasks, filters = {} }: { tasks: TaskCardData[]; filters?: Filters }) {
  return (
    <TaskBoard
      key={taskBoardFilterKey(filters)}
      initialTasks={tasks}
      workspaceId="ws-1"
      orgSlug="rbcodelabs"
      workspaceSlug="compass"
      members={[]}
    />
  );
}

describe("taskBoardFilterKey", () => {
  it("is stable for the same filters and distinct for different ones", () => {
    expect(taskBoardFilterKey({ assignee: "user:user-alice" })).toBe(
      taskBoardFilterKey({ assignee: "user:user-alice" })
    );
    expect(taskBoardFilterKey({ assignee: "user:user-alice" })).not.toBe(
      taskBoardFilterKey({ assignee: "__unassigned__" })
    );
    expect(taskBoardFilterKey({})).not.toBe(taskBoardFilterKey({ assignee: "user:user-alice" }));
  });

  it("treats an absent filter and an explicitly empty one as the same view", () => {
    expect(taskBoardFilterKey({})).toBe(taskBoardFilterKey({ squad: null, assignee: null, priority: null }));
  });

  it("distinguishes each facet independently, so a key cannot collide across facets", () => {
    const keys = new Set([
      taskBoardFilterKey({ squad: "x" }),
      taskBoardFilterKey({ assignee: "x" }),
      taskBoardFilterKey({ priority: "x" }),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("TaskBoard filter remount", () => {
  afterEach(() => cleanup());

  it("narrows the board when a filter change remounts it with fewer tasks", () => {
    const { rerender } = render(<Page tasks={[alice, bob]} />);
    expect(screen.getByText("Alice task")).toBeVisible();
    expect(screen.getByText("Bob task")).toBeVisible();

    // What the server does on `?assignee=user:user-alice`: narrowed task set,
    // and a new key because the filter changed.
    rerender(<Page tasks={[alice]} filters={{ assignee: "user:user-alice" }} />);

    expect(screen.getByText("Alice task")).toBeVisible();
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();
  });

  it("widens the board again when the filter is cleared", () => {
    const { rerender } = render(<Page tasks={[alice]} filters={{ assignee: "user:user-alice" }} />);
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();

    rerender(<Page tasks={[alice, bob]} />);

    expect(screen.getByText("Bob task")).toBeVisible();
  });

  it("shows an emptied board when a filter matches nothing", () => {
    const { rerender } = render(<Page tasks={[alice, bob]} />);

    rerender(<Page tasks={[]} filters={{ assignee: "__unassigned__" }} />);

    expect(screen.queryByText("Alice task")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob task")).not.toBeInTheDocument();
  });

  it("does not revert an optimistic move when revalidation re-sends the pre-move task set", async () => {
    const { rerender } = render(<Page tasks={[alice, bob]} />);
    const todoColumn = () => document.querySelector<HTMLElement>('[data-task-column="TODO"]')!;
    expect(todoColumn().textContent).toContain("Alice task");

    // Drive a real optimistic column move through the card menu. This is the
    // same setColumns path drag-and-drop uses: the client moves the task
    // immediately, and the server props still describe the pre-move state.
    fireEvent.click(within(todoColumn()).getAllByRole("button", { name: "Card actions" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cancel" }));
    expect(todoColumn().textContent).not.toContain("Alice task");
    expect(screen.getByRole("button", { name: /Show cancelled \(1\)/ })).toBeVisible();

    // Revalidation lands under an unchanged filter, so the key is unchanged and
    // the board must leave its optimistic state alone.
    rerender(<Page tasks={[alice, bob]} />);

    expect(todoColumn().textContent).not.toContain("Alice task");
    expect(screen.getByRole("button", { name: /Show cancelled \(1\)/ })).toBeVisible();
  });

  it("also holds its optimistic state when revalidation changes the task set under an unchanged filter", async () => {
    // The deliberate tradeoff of keying on the filter instead of on the task
    // set: a task appearing from elsewhere (another session, an MCP write) does
    // not force a rebuild, so a pending optimistic move is never discarded by
    // an unrelated change. The new task simply is not shown until something
    // does remount the board.
    const { rerender } = render(<Page tasks={[alice, bob]} />);
    const todoColumn = () => document.querySelector<HTMLElement>('[data-task-column="TODO"]')!;

    fireEvent.click(within(todoColumn()).getAllByRole("button", { name: "Card actions" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cancel" }));
    expect(todoColumn().textContent).not.toContain("Alice task");

    const carol = task({ id: "t-carol", title: "Carol task", sortOrder: 2 });
    rerender(<Page tasks={[alice, bob, carol]} />);

    // Optimistic state preserved …
    expect(todoColumn().textContent).not.toContain("Alice task");
    expect(screen.getByRole("button", { name: /Show cancelled \(1\)/ })).toBeVisible();
    // … at the cost of not picking up the newly arrived task.
    expect(screen.queryByText("Carol task")).not.toBeInTheDocument();
  });
});
