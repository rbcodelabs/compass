// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  usePathname: () => "/org/ws/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
import { TaskBoard } from "@/components/tasks/task-board";
import { TasksColumnLayoutProvider, useTasksColumnLayoutContext } from "@/components/tasks/tasks-column-layout";
import type { TaskCardData } from "@/components/tasks/task-card";

const STORAGE_KEY = "compass:tasks-column-layout:w1";

function setViewport(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: desktop && query.includes("768"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function task(id: string, title: string, status: TaskCardData["status"]): TaskCardData {
  return {
    id, title, description: null, status, priority: "MEDIUM", sortOrder: 0, squadId: null, squad: null, assigneeUserId: null,
    assigneeAgentId: null, assignee: null, ownerName: null, storyPoints: null, dueDate: null, iteration: null, parentTaskId: null,
    subtaskCount: 0, links: [],
  } as TaskCardData;
}

const tasks = [
  task("t1", "Plan work", "TODO"),
  task("t2", "Ship it", "DONE"),
  task("t3", "Also shipped", "DONE"),
  task("t4", "Stuck", "BLOCKED"),
  task("t5", "Dropped", "CANCELLED"),
];

function Board() {
  return (
    <PanelProvider orgSlug="org" workspaceSlug="ws">
      <TaskBoard initialTasks={tasks} workspaceId="w1" orgSlug="org" workspaceSlug="ws" members={[]} />
    </PanelProvider>
  );
}

const scroller = () => screen.getByRole("region", { name: "Task board" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tablist = () => screen.getByRole("tablist", { name: "Pinned columns" });
const tabs = () => within(tablist()).getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(tablist()).getByRole("tab", { name });
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);
const DEFAULT_ORDER = ["Backlog", "To Do", "In Progress", "Blocked", "In Review", "Done"];

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("Tasks board dock (md and up)", () => {
  it("defaults to no dock and the workflow order: nothing is pinned until someone pins", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("pinning a column docks it, opens the dock on it and leaves the rest in the scroller", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    expect(tabNames()).toEqual(["Done (2)"]);
    expect(tab(/^Done/)).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(headings(panel)).toEqual(["Done"]);
    expect(within(panel).getByText("Ship it")).toBeInTheDocument();
    expect(scroller()).not.toContainElement(pinnedRegion());
    expect(headings(scroller())).toEqual(["Backlog", "To Do", "In Progress", "Blocked", "In Review"]);
  });

  it("two pinned columns share ONE dock; tabs follow column order and switching swaps the single panel", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Blocked to the right" }));
    expect(screen.getAllByTestId("board-pinned-region")).toHaveLength(1);
    expect(tabNames()).toEqual(["Blocked (1)", "Done (2)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Blocked"]);
    fireEvent.click(tab(/^Done/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Done"]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(headings(scroller())).toEqual(["Backlog", "To Do", "In Progress", "In Review"]);
  });

  it("clicking the active tab, or the panel's collapse button, collapses the dock to its rail", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    fireEvent.click(tab(/^Done/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    fireEvent.click(tab(/^Done/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Collapse Done" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Done (2)"]);
  });

  it("unpinning the last column removes the dock and returns the column to the scroller in its order", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Done" }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("reorders from the column menu; the layout's order is the only column order", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Backlog column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller()).slice(0, 3)).toEqual(["To Do", "Backlog", "In Progress"]);
  });

  it("the open docked panel keeps its Add task footer and its cards draggable", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("button", { name: /add task/i })).toBeInTheDocument();
    expect(within(panel).getAllByLabelText("Drag to reorder")).toHaveLength(2);
  });

  it("makes each tab a drop target (a wrapper per tab)", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Blocked to the right" }));
    expect(document.querySelectorAll("[data-slot=task-dock-tab-drop]")).toHaveLength(2);
  });

  it("mirrors the layout to this browser's localStorage and restores it", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Done to the right" }));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.pinnedColumnIds).toEqual(["DONE"]);
    first.unmount();
    render(<Board />);
    expect(tabNames()).toEqual(["Done (2)"]);
  });

  it("falls back to the default layout when the stored one is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const first = render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" }));
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });
});

describe("Tasks board: Show cancelled changes the column set", () => {
  const pinnedCancelled = JSON.stringify({
    columnOrder: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"],
    pinnedColumnIds: ["CANCELLED"],
    activePinnedId: "CANCELLED",
    dockCollapsed: false,
  });

  it("renders no CANCELLED column until the toggle is on, and the toggle lists it in the scroller", () => {
    render(<Board />);
    expect(headings(scroller())).not.toContain("Cancelled");
    fireEvent.click(screen.getByRole("button", { name: /show cancelled \(1\)/i }));
    expect(headings(scroller())).toEqual([...DEFAULT_ORDER, "Cancelled"]);
    fireEvent.click(screen.getByRole("button", { name: /hide cancelled/i }));
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("a pinned CANCELLED stays pinned in the layout but is filtered out of the dock while hidden, and comes back with the toggle", () => {
    window.localStorage.setItem(STORAGE_KEY, pinnedCancelled);
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);

    fireEvent.click(screen.getByRole("button", { name: /show cancelled/i }));
    expect(tabNames()).toEqual(["Cancelled (1)"]);
    expect(within(screen.getByRole("tabpanel")).getByText("Dropped")).toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);

    fireEvent.click(screen.getByRole("button", { name: /hide cancelled/i }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    // still pinned in the stored layout
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).pinnedColumnIds).toEqual(["CANCELLED"]);
  });

  it("falls back to another pinned tab while a pinned active CANCELLED is hidden", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnOrder: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"],
        pinnedColumnIds: ["DONE", "CANCELLED"],
        activePinnedId: "CANCELLED",
        dockCollapsed: false,
      }),
    );
    render(<Board />);
    expect(tabNames()).toEqual(["Done (2)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Done"]);
  });
});

describe("Tasks board dock below md", () => {
  beforeEach(() => setViewport(false));

  it("has no dock and no pin controls: every column is a scroller column", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("keeps pinned state in the layout but renders pinned columns in the scroller in saved order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["DONE", "BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "CANCELLED"], pinnedColumnIds: ["DONE"], activePinnedId: "DONE", dockCollapsed: false }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Done", "Backlog", "To Do", "In Progress", "Blocked", "In Review"]);
  });

  it("keeps the mobile snap-column sizing on scroller columns", () => {
    render(<Board />);
    const column = document.querySelector<HTMLElement>('[data-task-column="TODO"]')!;
    expect(column.className).toContain("w-[calc(100cqw-1.5rem)]");
  });

  it("still allows reordering from the menu", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Done column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move left" }));
    expect(headings(scroller()).slice(-2)).toEqual(["Done", "In Review"]);
  });
});

describe("TasksColumnLayoutProvider", () => {
  function Probe() {
    const ctx = useTasksColumnLayoutContext();
    return <output data-testid="stored">{JSON.stringify(ctx?.stored ?? null)}</output>;
  }
  function Page({ columnLayout, version = "v1", id = "view-1" }: { columnLayout: unknown; version?: string; id?: string }) {
    return (
      <TasksColumnLayoutProvider workspaceId="w1" savedView={{ id, version, columnLayout }}>
        <Probe />
        <Board />
      </TasksColumnLayoutProvider>
    );
  }
  const saved = {
    columnOrder: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"],
    pinnedColumnIds: ["DONE"],
    activePinnedId: "DONE",
    dockCollapsed: false,
  };

  it("starts from the saved view's layout, ignoring this browser's localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, pinnedColumnIds: ["BLOCKED"], activePinnedId: "BLOCKED" }));
    render(<Page columnLayout={saved} />);
    expect(tabNames()).toEqual(["Done (2)"]);
  });

  it("exposes the live layout for Save: null while default, the layout once changed, and leaves localStorage alone", () => {
    render(<Page columnLayout={undefined} />);
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Pin Backlog to the right" }));
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toMatchObject({ pinnedColumnIds: ["BACKLOG"], activePinnedId: "BACKLOG" });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("a corrupt saved layout degrades to the default", () => {
    render(<Page columnLayout={{ columnOrder: "nope" }} />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });
});
