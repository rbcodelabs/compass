// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// A module-scoped spy, not a fresh `vi.fn()` per `useRouter()` call: opening a
// panel is a `router.push`, and a per-call mock cannot be asserted against
// after the fact.
const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/rbcodelabs/compass/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider, usePanelContext } from "@/components/panels/panel-context";
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

/** The grid's scroll viewport — `table-container`, never an outer wrapper. */
function viewport(view: ReturnType<typeof renderList>) {
  const node = view.container.querySelector('[data-slot="table-container"]');
  if (!node) throw new Error("table-container not found");
  return node as HTMLElement;
}

/**
 * Title buttons in row order.
 *
 * Scoped to the title cells rather than a bare `getAllByRole("button")`: the
 * grid's header cells render a real `<Button>` for any sortable column, so a
 * page-wide button query would silently start picking up chrome the day a
 * Tasks column gains `sortable`.
 */
function titleButtons(): HTMLElement[] {
  return screen
    .getAllByTestId("grid-cell-title")
    .map((cell) => within(cell).getByRole("button"));
}

// The grid reads `matchMedia` through `useIsMobile`; jsdom does not ship one.
beforeEach(() => {
  push.mockClear();
  replace.mockClear();
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
    expect(titleButtons().map((btn) => btn.textContent)).toEqual([
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

    const titles = titleButtons();
    expect(titles.map((btn) => btn.textContent)).toEqual([
      "First root",
      "First child",
      "Second child",
      "Second root",
    ]);

    expect(within(titles[0].closest("td")!).getByRole("button")).toHaveTextContent("First root");

    // Depth is encoded on an inner element rather than the cell's own padding:
    // the grid's TableCell takes a className, never a style. The invariant the
    // original assertion protected is unchanged — nesting is visually encoded
    // and proportional to depth — only the element carrying it moved, so the
    // values are `depth * 20` rather than the old table's `12 + depth * 20`.
    expect(titles[0].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "0px" });
    expect(titles[1].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "20px" });
    expect(titles[2].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "20px" });
    expect(titles[3].closest("div[data-depth]")).toHaveStyle({ paddingLeft: "0px" });
    expect(titles[1].closest("div[data-depth]")).toHaveAttribute("data-depth", "1");
  });

  // Regression: the wrapper around the table used `overflow-hidden`, which
  // — inside WorkspacePage's `md:overflow-hidden` content area — silently
  // clipped rows and the table's own horizontal scrollbar past the fold with
  // no way to reach them ("the table doesn't scroll" bug). This view must own
  // a real scroll viewport: bounded height (`min-h-0 flex-1`) and
  // `overflow-y-auto`, never a bare `overflow-hidden`.
  //
  // The viewport has since moved OFF the page-level wrapper this view used to
  // render (the old `data-testid="task-list-scroll"` div) and ONTO the grid's
  // own `table-container`, because that div is already a scroll container
  // (`overflow-x: auto` computes `overflow-y` to `auto`) and is therefore
  // where a sticky `<th>` resolves. A wrapper outside it would scroll the
  // header away with the rows.
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

/**
 * PR #228 moved tasks out of a dedicated `/tasks/{id}` page and into the shared
 * inline-editable detail panel. These hold the grid to that behaviour: a title
 * opens the panel, and an edit made in the panel reaches the grid.
 */
describe("TaskListView detail panel integration", () => {
  afterEach(() => cleanup());

  it("opens the shared detail panel instead of navigating to a task page", () => {
    renderList([task({ id: "t1", title: "Ship the data grid" })]);

    const title = titleButtons()[0];
    // A button, not a link: the old `<Link href="/{org}/{ws}/tasks/{id}">`
    // navigated away from the list.
    expect(title.tagName).toBe("BUTTON");
    expect(screen.queryByRole("link", { name: "Ship the data grid" })).not.toBeInTheDocument();

    fireEvent.click(title);

    // `openPanel` pushes `?detail=task:{id}`, preserving other params.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/rbcodelabs/compass/tasks?detail=task%3At1", {
      scroll: false,
    });
  });

  /*
    The panel is a layout sibling of this grid, not a child, so an edit there
    reaches the rows only through `notifyEntityMutated`. Without the
    subscription the row silently shows stale content until a manual refresh.
  */
  it("updates the matching row when the panel reports a mutation", () => {
    function Harness() {
      const { notifyEntityMutated } = usePanelContext();
      return (
        <>
          <button
            type="button"
            data-testid="fire-mutation"
            onClick={() =>
              notifyEntityMutated("task", "t1", {
                task: task({ id: "t1", title: "Renamed in the panel", priority: "URGENT" }),
              })
            }
          />
          <TaskListView
            tasks={[task({ id: "t1", title: "Original title" }), task({ id: "t2", title: "Untouched", sortOrder: 2 })]}
            orgSlug="rbcodelabs"
            workspaceSlug="compass"
            members={[]}
          />
        </>
      );
    }

    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Harness />
      </PanelProvider>,
    );

    expect(titleButtons().map((b) => b.textContent)).toEqual(["Original title", "Untouched"]);

    fireEvent.click(screen.getByTestId("fire-mutation"));

    // The edited row picks up both the new title and the new priority...
    expect(titleButtons().map((b) => b.textContent)).toEqual([
      "Renamed in the panel",
      "Untouched",
    ]);
    expect(screen.getByText("Urgent")).toBeVisible();
    // ...and the untouched row is not disturbed.
    expect(screen.getAllByTestId("grid-row")).toHaveLength(2);
  });

  /*
    The churn hazard, exercised at its real trigger.

    `openPanel` is a `useCallback` over `[router, pathname, searchParams]` and
    `useSearchParams()` returns a fresh object, so `openPanel`'s identity
    changes whenever the PROVIDER re-renders. If a cell closes over it directly
    and the column memo depends on it, the column definitions churn and
    `table.FlexRender` tears down and rebuilds every cell subtree.

    The trigger has to be a re-render ABOVE the provider. A `setTasks` inside
    TaskListView does NOT qualify — the grid is a child of the provider, so its
    own state updates never re-render the provider and `openPanel` keeps its
    identity no matter how the columns are memoised. An earlier version of this
    test used the mutation path and passed against both the safe and the unsafe
    implementation; it proved nothing.
  */
  it("does not remount cells when a provider re-render changes openPanel's identity", () => {
    function Harness() {
      const [, force] = useState(0);
      return (
        <>
          <button type="button" data-testid="force-provider" onClick={() => force((n) => n + 1)} />
          <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
            <TaskListView
              tasks={[task({ id: "t1", title: "Original" })]}
              orgSlug="rbcodelabs"
              workspaceSlug="compass"
              members={[]}
            />
          </PanelProvider>
        </>
      );
    }

    render(<Harness />);

    const cellBefore = screen.getByTestId("grid-cell-title");
    const rowBefore = screen.getByTestId("grid-row");
    const buttonBefore = titleButtons()[0];

    fireEvent.click(screen.getByTestId("force-provider"));

    // The very same DOM nodes: updated in place, never torn down.
    expect(screen.getByTestId("grid-row")).toBe(rowBefore);
    expect(screen.getByTestId("grid-cell-title")).toBe(cellBefore);
    expect(titleButtons()[0]).toBe(buttonBefore);
  });

  it("keeps row and cell identity stable across a panel mutation", () => {
    function Harness() {
      const { notifyEntityMutated } = usePanelContext();
      return (
        <>
          <button
            type="button"
            data-testid="fire-mutation"
            onClick={() =>
              notifyEntityMutated("task", "t1", {
                task: task({ id: "t1", title: "Renamed" }),
              })
            }
          />
          <TaskListView
            tasks={[task({ id: "t1", title: "Original" })]}
            orgSlug="rbcodelabs"
            workspaceSlug="compass"
            members={[]}
          />
        </>
      );
    }

    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Harness />
      </PanelProvider>,
    );

    const cellBefore = screen.getByTestId("grid-cell-title");
    const rowBefore = screen.getByTestId("grid-row");

    fireEvent.click(screen.getByTestId("fire-mutation"));

    // Same DOM nodes, new content — the row is patched, not replaced, so no
    // flash of stale content and no scroll-position loss.
    expect(screen.getByTestId("grid-cell-title")).toBe(cellBefore);
    expect(screen.getByTestId("grid-row")).toBe(rowBefore);
    expect(cellBefore).toHaveTextContent("Renamed");
  });
});
