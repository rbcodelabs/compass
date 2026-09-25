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
}));
vi.mock("@/lib/task-assignees-client", () => ({ fetchTaskAssigneeOptions: vi.fn().mockResolvedValue([]) }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({ assignSquad: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskListView } from "@/components/tasks/task-list-view";
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

// The "detail" surface (formerly TaskHeader, a read-only label matching
// taskAssigneeDisplay) is gone — TaskDetail's assignee slot is now always an
// editable TaskAssigneePicker, not a passive label, so "Unassigned" /
// "Unavailable assignee" copy no longer applies there the same way. Card and
// list are still passive labels driven by taskAssigneeDisplay, so they keep
// this coverage.
const surfaces = {
  card: (t: TaskCardData) =>
    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <TaskBoard initialTasks={[t]} workspaceId="ws-1" orgSlug="rbcodelabs" workspaceSlug="compass" members={[]} />
      </PanelProvider>
    ),
  list: (t: TaskCardData) =>
    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <TaskListView tasks={[t]} orgSlug="rbcodelabs" workspaceSlug="compass" members={[]} />
      </PanelProvider>
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
