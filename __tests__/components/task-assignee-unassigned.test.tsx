// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  moveTaskStatus: vi.fn(),
  updateSortOrder: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  addTask: vi.fn(),
  getTaskAssigneeOptions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({ assignSquad: vi.fn() }));

import { TaskBoard } from "@/components/tasks/task-board";
import { TaskListView } from "@/components/tasks/task-list-view";
import { TaskHeader } from "@/components/tasks/task-header";
import type { TaskCardData } from "@/components/tasks/task-card";

function task(overrides: Partial<TaskCardData> = {}): TaskCardData {
  return {
    id: "t-1",
    title: "Unowned work",
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

const surfaces = {
  card: (t: TaskCardData) =>
    render(
      <TaskBoard initialTasks={[t]} workspaceId="ws-1" orgSlug="rbcodelabs" workspaceSlug="compass" members={[]} />
    ),
  list: (t: TaskCardData) =>
    render(<TaskListView tasks={[t]} orgSlug="rbcodelabs" workspaceSlug="compass" members={[]} />),
  detail: (t: TaskCardData) =>
    render(
      <TaskHeader
        task={t}
        workspaceId="ws-1"
        squads={[]}
        members={[]}
        revalidatePathStr="/rbcodelabs/compass/tasks/t-1"
      />
    ),
};

describe.each(Object.entries(surfaces))("%s surface unassigned state", (_name, mount) => {
  afterEach(() => cleanup());

  it("renders an explicit Unassigned label instead of a blank slot", () => {
    mount(task());
    const label = screen.getByText("Unassigned");
    expect(label).toBeVisible();
    // Clearly secondary: a de-emphasized semantic text role, not a real name.
    expect(label.className).toMatch(/italic/);
    expect(label.className).toMatch(/text-text-subtle/);
  });

  it("does not claim Unassigned for a task whose assignee is merely unresolvable", () => {
    mount(task({ assigneeUserId: "11111111-1111-1111-1111-111111111111" }));
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable assignee")).toBeVisible();
  });

  it("does not claim Unassigned when only a freeform owner name is set", () => {
    mount(task({ ownerName: "External stakeholder" }));
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
    expect(screen.getByText("External stakeholder")).toBeVisible();
  });
});
