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
}));
vi.mock("@/lib/task-assignees-client", () => ({ fetchTaskAssigneeOptions: vi.fn().mockResolvedValue([]) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
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
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <TaskBoard
        key={taskBoardFilterKey(filters)}
        initialTasks={tasks}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    </PanelProvider>
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
      taskBoardFilterKey({ field: "x" }),
      taskBoardFilterKey({ fieldValue: "x" }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("changes when the custom-field tag filter changes, so the board resyncs", () => {
    expect(taskBoardFilterKey({ field: "f1", fieldValue: "payments" })).not.toBe(
      taskBoardFilterKey({ field: "f1", fieldValue: "billing" })
    );
    expect(taskBoardFilterKey({ field: "f1", fieldValue: "payments" })).toBe(
      taskBoardFilterKey({ field: "f1", fieldValue: "payments" })
    );
    expect(taskBoardFilterKey({})).toBe(taskBoardFilterKey({ field: null, fieldValue: null }));
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

  it("adopts server truth when revalidation disagrees with an idle optimistic move", async () => {
    // Moves in flight are protected by the busy guard in useServerSyncedState
    // (drag / pending transition). Once the board is idle the server is
    // authoritative, which is what lets an agent's change show up live.
    const { rerender } = render(<Page tasks={[alice, bob]} />);
    const todoColumn = () => document.querySelector<HTMLElement>('[data-task-column="TODO"]')!;

    fireEvent.click(within(todoColumn()).getAllByRole("button", { name: "Card actions" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cancel" }));
    expect(todoColumn().textContent).not.toContain("Alice task");

    rerender(<Page tasks={[alice, bob]} />);

    expect(todoColumn().textContent).toContain("Alice task");
  });

  it("picks up a task that arrives from elsewhere under an unchanged filter", () => {
    const { rerender } = render(<Page tasks={[alice, bob]} />);

    const carol = task({ id: "t-carol", title: "Carol task", sortOrder: 2 });
    rerender(<Page tasks={[alice, bob, carol]} />);

    expect(screen.getByText("Carol task")).toBeVisible();
  });

  it("moves a card to another column when the server reports a new status", () => {
    const { rerender } = render(<Page tasks={[alice, bob]} />);
    const column = (status: string) => document.querySelector<HTMLElement>(`[data-task-column="${status}"]`)!;
    expect(column("TODO").textContent).toContain("Alice task");

    rerender(<Page tasks={[{ ...alice, status: "IN_PROGRESS" }, bob]} />);

    expect(column("TODO").textContent).not.toContain("Alice task");
    expect(column("IN_PROGRESS").textContent).toContain("Alice task");
  });
});
