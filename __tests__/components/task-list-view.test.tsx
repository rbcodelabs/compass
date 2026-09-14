// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { TaskListView } from "@/components/tasks/task-list-view";
import type { TaskCardData } from "@/components/tasks/task-card";
import { expectEveryGridCellClipped } from "../helpers/grid-cells";

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

function renderList(tasks: TaskCardData[], props: { height?: "fill" | "natural" } = {}) {
  return render(
    <TaskListView
      tasks={tasks}
      orgSlug="rbcodelabs"
      workspaceSlug="compass"
      members={[]}
      {...props}
    />
  );
}

/** The grid's scroll viewport — `table-container`, never an outer wrapper. */
function viewport(view: ReturnType<typeof renderList>) {
  const node = view.container.querySelector('[data-slot="table-container"]');
  if (!node) throw new Error("table-container not found");
  return node as HTMLElement;
}

// The grid reads `matchMedia` through `useIsMobile`; jsdom does not ship one.
beforeEach(() => {
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
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
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

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "First root",
      "First child",
      "Second child",
      "Second root",
    ]);

    expect(within(links[0].closest("td")!).getByRole("link")).toHaveTextContent("First root");

    // Depth is encoded on an inner element rather than the cell's own padding:
    // the grid's TableCell takes a className, never a style. The invariant the
    // original assertion protected is unchanged — nesting is visually encoded
    // and proportional to depth — only the element carrying it moved.
    expect(links[0].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "0px" });
    expect(links[1].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "20px" });
    expect(links[2].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "20px" });
    expect(links[3].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "0px" });
    expect(links[1].closest("div[data-depth]")).toHaveAttribute("data-depth", "1");
  });

  // Regression: the wrapper around the table used `overflow-hidden`, which
  // — inside WorkspacePage's `md:overflow-hidden` content area — silently
  // clipped rows and the table's own horizontal scrollbar past the fold with
  // no way to reach them ("the table doesn't scroll" bug). This view must own
  // a real scroll viewport: bounded height (`min-h-0 flex-1`) and
  // `overflow-y-auto`, never a bare `overflow-hidden`.
  //
  // The viewport has since moved OFF the page-level wrapper this view used to
  // render and ONTO the grid's own `table-container`, because that div is
  // already a scroll container (`overflow-x: auto` computes `overflow-y` to
  // `auto`) and is therefore where a sticky `<th>` resolves. A wrapper outside
  // it would scroll the header away with the rows.
  it("makes the grid's own table-container the scroll viewport in fill mode", () => {
    const view = renderList([task({ id: "only", title: "Only task" })]);

    const scrollContainer = viewport(view);
    expect(scrollContainer.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    // The horizontal axis is untouched: two separate bugs have been filed
    // against it and the fixed layout that fixed them must survive.
    expect(scrollContainer.className).toMatch(/(?:^|\s)overflow-x-auto(?:\s|$)/);
  });

  // The other half of the same invariant: the header has to stay put while
  // rows move under it, which only works if it is sticky AND opaque.
  it("sticks the header row to the top of the viewport", () => {
    renderList([task({ id: "only", title: "Only task" })]);

    const heads = screen.getAllByRole("columnheader");
    expect(heads).toHaveLength(8);
    for (const head of heads) {
      expect(head.className).toMatch(/(?:^|\s)sticky(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)top-0(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)bg-surface-panel(?:\s|$)/);
    }
  });

  // The subtasks panel renders the same component in a normally-scrolling
  // column. `flex-1`/`min-h-0` there is inert at best and collapses the grid
  // at worst, so the mode must actually change the shape.
  it("does not claim flex height in natural mode", () => {
    const view = renderList([task({ id: "only", title: "Only task" })], { height: "natural" });

    const scrollContainer = viewport(view);
    expect(scrollContainer.className).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    expect(scrollContainer.className).not.toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    // Still bounded, or the header would have nothing to stick to.
    expect(scrollContainer.className).toMatch(/max-h-\(--data-grid-max-h\)/);
    expect(screen.getByTestId("data-grid")).toHaveStyle({
      "--data-grid-max-h": "24rem",
    });
  });

  it("renders no pagination footer or column menu for an unpaginated list", () => {
    renderList([task({ id: "only", title: "Only task" })]);

    expect(screen.queryByTestId("grid-pagination")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Columns/i })).not.toBeInTheDocument();
  });

  // Regression: reported against the PR preview. Under `table-fixed` the 9rem
  // Assignee column is a hard box and TableCell is `whitespace-nowrap`, so an
  // assignee name wider than 9rem escaped the cell and painted over the Squad
  // column's value.
  it("clips an over-long assignee instead of painting it over the next column", () => {
    const view = renderList([
      task({
        id: "t1",
        title: "Ship the data grid",
        ownerName: "Sample Workspace Admin",
        squad: { id: "s1", name: "Core Product", color: "#3b82f6" },
      }),
    ]);

    const assignee = within(view.container).getByTestId("grid-cell-assignee");
    expect(assignee).toHaveTextContent("Sample Workspace Admin");
    expect(assignee.className).toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);

    // Not just Assignee: every column carries the guarantee, including any
    // added later.
    expectEveryGridCellClipped(view.container);
  });
});
