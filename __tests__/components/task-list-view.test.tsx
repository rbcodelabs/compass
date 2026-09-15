// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
import { TaskListView } from "@/components/tasks/task-list-view";
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

function renderList(tasks: TaskCardData[]) {
  return render(
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <TaskListView
        tasks={tasks}
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        members={[]}
      />
    </PanelProvider>
  );
}

describe("TaskListView hierarchy", () => {
  afterEach(() => cleanup());

  it("shows an unavailable agent instead of the external owner label", () => {
    renderList([task({ id: "assigned", title: "Assigned", ownerName: "External stakeholder", assigneeAgentId: "agent", assignee: { type: "AGENT", id: "agent", displayName: "Engineer", available: false } })]);
    expect(screen.getByText("Agent: Engineer (unavailable)")).toBeVisible();
    expect(screen.queryByText("External stakeholder")).not.toBeInTheDocument();
  });

  it("does not mislabel a departed human as the external owner", () => {
    renderList([task({ id: "assigned", title: "Assigned", ownerName: "External stakeholder", assigneeUserId: "departed" })]);
    expect(screen.getByText("Unavailable assignee")).toBeVisible();
    expect(screen.queryByText("External stakeholder")).not.toBeInTheDocument();
  });

  it("renders every task in a partial forest whose shared parent is absent", () => {
    renderList([
      task({ id: "child-4", title: "Fourth child", parentTaskId: "missing-parent", sortOrder: 4 }),
      task({ id: "child-2", title: "Second child", parentTaskId: "missing-parent", sortOrder: 2 }),
      task({ id: "child-1", title: "First child", parentTaskId: "missing-parent", sortOrder: 1 }),
      task({ id: "child-3", title: "Third child", parentTaskId: "missing-parent", sortOrder: 3 }),
    ]);

    expect(screen.queryByText("No tasks match the current filters.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((btn) => btn.textContent)).toEqual([
      "First child",
      "Second child",
      "Third child",
      "Fourth child",
    ]);
  });

  it("preserves ordering and indentation for a complete parent-child tree", () => {
    renderList([
      task({ id: "child-2", title: "Second child", parentTaskId: "parent", sortOrder: 2 }),
      task({ id: "sibling", title: "Second root", sortOrder: 2 }),
      task({ id: "parent", title: "First root", sortOrder: 1 }),
      task({ id: "child-1", title: "First child", parentTaskId: "parent", sortOrder: 1 }),
    ]);

    const rows = screen.getAllByRole("button");
    expect(rows.map((btn) => btn.textContent)).toEqual([
      "First root",
      "First child",
      "Second child",
      "Second root",
    ]);

    expect(within(rows[0].closest("td")!).getByRole("button")).toHaveTextContent("First root");
    expect(rows[0].closest("td")).toHaveStyle({ paddingLeft: "12px" });
    expect(rows[1].closest("td")).toHaveStyle({ paddingLeft: "32px" });
    expect(rows[2].closest("td")).toHaveStyle({ paddingLeft: "32px" });
    expect(rows[3].closest("td")).toHaveStyle({ paddingLeft: "12px" });
  });

  // Regression: the wrapper around the table used `overflow-hidden`, which
  // — inside WorkspacePage's `md:overflow-hidden` content area — silently
  // clipped rows and the table's own horizontal scrollbar past the fold with
  // no way to reach them ("the table doesn't scroll" bug). The wrapper must
  // be the scroll viewport itself: bounded height (`min-h-0 flex-1`) and
  // `overflow-y-auto`, never a bare `overflow-hidden`.
  it("makes its own wrapper the scroll viewport instead of clipping overflow", () => {
    renderList([task({ id: "only", title: "Only task" })]);

    const scrollContainer = screen.getByTestId("task-list-scroll");
    expect(scrollContainer.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });
});
