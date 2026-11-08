// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  moveTaskStatus: vi.fn(),
  handlers: {} as Record<string, (event: unknown) => void>,
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  moveTaskStatus: mocks.moveTaskStatus,
  updateSortOrder: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  addTask: vi.fn(),
}));
vi.mock("@/lib/task-assignees-client", () => ({ fetchTaskAssigneeOptions: vi.fn().mockResolvedValue([]) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/org/ws/tasks",
  useSearchParams: () => new URLSearchParams(),
}));
// Capture the board's drag handlers on every render so the test can drive them with synthetic dnd-kit events.
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Record<string, unknown> & { children: React.ReactNode }) => {
      mocks.handlers.start = props.onDragStart as (event: unknown) => void;
      mocks.handlers.over = props.onDragOver as (event: unknown) => void;
      mocks.handlers.end = props.onDragEnd as (event: unknown) => void;
      mocks.handlers.cancel = props.onDragCancel as (event: unknown) => void;
      return <actual.DndContext {...(props as object)} />;
    },
  };
});

import { PanelProvider } from "@/components/panels/panel-context";
import { TaskBoard } from "@/components/tasks/task-board";
import type { TaskCardData } from "@/components/tasks/task-card";

const STORAGE_KEY = "compass:tasks-column-layout:w1";

function task(id: string, title: string, status: TaskCardData["status"]): TaskCardData {
  return {
    id, title, description: null, status, priority: "MEDIUM", sortOrder: 0, squadId: null, squad: null, assigneeUserId: null,
    assigneeAgentId: null, assignee: null, ownerName: null, storyPoints: null, dueDate: null, iteration: null, parentTaskId: null,
    subtaskCount: 0, links: [],
  } as TaskCardData;
}

function Board() {
  return (
    <PanelProvider orgSlug="org" workspaceSlug="ws">
      <TaskBoard
        initialTasks={[task("t1", "Plan work", "TODO"), task("t2", "Ship it", "DONE"), task("t4", "Stuck", "BLOCKED")]}
        workspaceId="w1"
        orgSlug="org"
        workspaceSlug="ws"
        members={[]}
      />
    </PanelProvider>
  );
}

const col = (status: string) => document.querySelector<HTMLElement>(`[data-task-column="${status}"]`);
const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Pinned columns" })).getByRole("tab", { name });
const tabData = (status: string) => ({ current: { status, dockTab: true } });

beforeEach(() => {
  window.localStorage.clear();
  mocks.moveTaskStatus.mockReset();
  window.matchMedia = ((query: string) => ({
    matches: query.includes("768"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // Done and Blocked are docked; Blocked is the open panel, so the DONE tab has no rendered column behind it.
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      columnOrder: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"],
      pinnedColumnIds: ["BLOCKED", "DONE"],
      activePinnedId: "BLOCKED",
      dockCollapsed: false,
    }),
  );
});
afterEach(() => cleanup());

describe("dragging a task over and onto a dock tab", () => {
  function startDrag() {
    render(<Board />);
    act(() => mocks.handlers.start({ active: { id: "t1" } }));
  }

  it("keeps the card in its own column while hovering a tab whose column is not rendered", () => {
    startDrag();
    expect(col("DONE")).toBeNull();
    act(() => mocks.handlers.over({ active: { id: "t1" }, over: { id: "column-DONE", data: tabData("DONE") } }));
    expect(col("TODO")).toHaveTextContent("Plan work");
    expect(tab(/^Done \(1\)/)).toBeInTheDocument();
    expect(mocks.moveTaskStatus).not.toHaveBeenCalled();
  });

  it("resolves the drop at drag end: optimistic append to the tab's column and the move action", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "t1" }, over: { id: "column-DONE", data: tabData("DONE") } }));
    act(() => mocks.handlers.end({ active: { id: "t1" }, over: { id: "column-DONE", data: tabData("DONE") } }));
    expect(col("TODO")).not.toHaveTextContent("Plan work");
    expect(tab(/^Done \(2\)/)).toBeInTheDocument();
    expect(mocks.moveTaskStatus).toHaveBeenCalledWith("t1", "DONE", "w1", "/org/ws/tasks");
  });

  it("a drop on the card's own tab is a no-op", () => {
    render(<Board />);
    act(() => mocks.handlers.start({ active: { id: "t2" } }));
    act(() => mocks.handlers.end({ active: { id: "t2" }, over: { id: "column-DONE", data: tabData("DONE") } }));
    expect(mocks.moveTaskStatus).not.toHaveBeenCalled();
    expect(tab(/^Done \(1\)/)).toBeInTheDocument();
  });

  it("an ordinary column is still an optimistic drag-over target", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "t1" }, over: { id: "column-BLOCKED", data: { current: { status: "BLOCKED" } } } }));
    expect(col("TODO")).not.toHaveTextContent("Plan work");
    expect(col("BLOCKED")).toHaveTextContent("Plan work");
  });

  it("a cancelled drag (Escape) puts the card back where the drag began", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "t1" }, over: { id: "column-BLOCKED", data: { current: { status: "BLOCKED" } } } }));
    expect(col("BLOCKED")).toHaveTextContent("Plan work");
    act(() => mocks.handlers.cancel({ active: { id: "t1" } }));
    expect(col("TODO")).toHaveTextContent("Plan work");
    expect(col("BLOCKED")).not.toHaveTextContent("Plan work");
    expect(mocks.moveTaskStatus).not.toHaveBeenCalled();
    // the board is idle again: a click on a tab still works
    fireEvent.click(tab(/^Done/));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Ship it");
  });
});
