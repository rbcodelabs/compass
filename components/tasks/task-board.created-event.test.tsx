// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({ moveTaskStatus: vi.fn(), updateSortOrder: vi.fn() }));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ subscribeEntityMutated: () => () => {} }) }));
vi.mock("./task-column", () => ({
  TaskColumn: ({ status, tasks }: { status: string; tasks: { id: string; title: string }[] }) => (
    <section aria-label={status}>
      {tasks.map((t) => <p key={t.id}>{t.title}</p>)}
    </section>
  ),
}));

import { TaskBoard } from "./task-board";
import type { TaskCardData } from "./task-card";
import { dispatchTaskCreated } from "@/lib/task-created-event";

function card(overrides: Partial<TaskCardData>): TaskCardData {
  return {
    id: "t",
    title: "Task",
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
  } as TaskCardData;
}

afterEach(cleanup);

describe("TaskBoard task-created event", () => {
  it("appends a created task to its status column exactly once", () => {
    render(<TaskBoard initialTasks={[card({ id: "a", title: "Existing" })]} workspaceId="ws" orgSlug="o" workspaceSlug="w" members={[]} />);
    expect(screen.getByText("Existing")).toBeInTheDocument();

    const created = card({ id: "b", title: "Fresh", status: "IN_PROGRESS" });
    act(() => dispatchTaskCreated(created));
    act(() => dispatchTaskCreated(created));

    const column = screen.getByRole("region", { name: "IN_PROGRESS" });
    expect(column).toHaveTextContent("Fresh");
    expect(screen.getAllByText("Fresh")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "TODO" })).toHaveTextContent("Existing");
  });

  it("stops listening after unmount", () => {
    const { unmount } = render(<TaskBoard initialTasks={[]} workspaceId="ws" orgSlug="o" workspaceSlug="w" members={[]} />);
    unmount();
    expect(() => act(() => dispatchTaskCreated(card({ id: "c", title: "Late" })))).not.toThrow();
    expect(screen.queryByText("Late")).not.toBeInTheDocument();
  });
});
