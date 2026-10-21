// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
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
    dueDate: "2026-10-20T00:00:00.000Z",
    iteration: null,
    parentTaskId: null,
    subtaskCount: 0,
    links: [],
    ...overrides,
  };
}

const TASKS = [task({ id: "t1", title: "Ship grid" }), task({ id: "t2", title: "Write docs", sortOrder: 1 })];

function renderList(readOnly = false) {
  return render(
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <TaskListView tasks={TASKS} orgSlug="rbcodelabs" workspaceSlug="compass" members={[]} readOnly={readOnly} />
    </PanelProvider>,
  );
}

const cell = (taskId: string, col: string) =>
  document.querySelector(`[data-row-id="${taskId}"] [data-col="${col}"]`) as HTMLElement;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockClear();
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TaskListView sheet mode", () => {
  it("renders a grid and edits a title through the entity PATCH endpoint", async () => {
    renderList();
    expect(screen.getByRole("grid", { name: "Tasks" })).toBeInTheDocument();

    const title = cell("t1", "title");
    act(() => title.focus());
    fireEvent.keyDown(title, { key: "Enter" });
    const input = screen.getByLabelText("Title for Ship grid");
    fireEvent.change(input, { target: { value: "Ship the grid" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/panels/entity/task/t1?orgSlug=rbcodelabs&workspaceSlug=compass");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ field: "title", value: "Ship the grid" });
    expect(cell("t1", "title")).toHaveTextContent("Ship the grid");
  });

  it("refuses to clear a title without calling the server", () => {
    renderList();
    const title = cell("t1", "title");
    act(() => title.focus());
    fireEvent.keyDown(title, { key: "Enter" });
    const input = screen.getByLabelText("Title for Ship grid");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("grid-live-region")).toHaveTextContent("Title is required");
  });

  it("sends a date-only due date and rolls back with the server's message on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid dueDate" }), { status: 400 }),
    );
    renderList();
    const due = cell("t1", "due");
    act(() => due.focus());
    fireEvent.keyDown(due, { key: "Enter" });
    const input = screen.getByLabelText("Due date for Ship grid");
    fireEvent.change(input, { target: { value: "11/02/2026" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("grid-error-strip")).toHaveTextContent("Invalid dueDate"));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      field: "dueDate",
      value: "2026-11-02",
    });
    expect(cell("t1", "due")).toHaveTextContent("Oct 20, 2026");
  });

  it("Alt+Enter opens the detail panel", () => {
    renderList();
    const title = cell("t2", "title");
    act(() => title.focus());
    fireEvent.keyDown(title, { key: "Enter", altKey: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0][0])).toContain("detail=task");
  });

  it("is not editable when the workspace is read-only", () => {
    renderList(true);
    const title = cell("t1", "title");
    expect(title).toHaveAttribute("aria-readonly", "true");
    act(() => title.focus());
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(title, { key: "x" });
    expect(screen.queryByTestId("grid-cell-input")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
