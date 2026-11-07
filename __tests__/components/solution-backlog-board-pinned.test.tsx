// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SolutionBacklogBoard, type SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";
import { SolutionsColumnLayoutProvider, useSolutionsColumnLayoutContext } from "@/components/solutions/solutions-column-layout";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  moveSolutionStatus: vi.fn(),
  updateSolutionStatus: vi.fn(),
  archiveSolution: vi.fn(),
}));

const STORAGE_KEY = "compass:solutions-column-layout:w1";

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

function item(id: string, title: string, status: SolutionBacklogItem["status"]): SolutionBacklogItem {
  return {
    id,
    title,
    description: null,
    status,
    sortOrder: 0,
    _count: { assumptions: 0, evidence: 0 },
    score: null,
    opportunity: { id: "opp-A", title: "Opportunity A", squad: null },
  };
}

const solutions = [item("s1", "Wizard", "IDEA"), item("s2", "Templates", "SHIPPED"), item("s3", "Old thing", "KILLED"), item("s4", "Other", "SHIPPED")];

function Board(props: Partial<React.ComponentProps<typeof SolutionBacklogBoard>> = {}) {
  return <SolutionBacklogBoard solutions={solutions} orgSlug="org" workspaceSlug="ws" workspaceId="w1" {...props} />;
}

const scroller = () => screen.getByRole("region", { name: "Solution backlog" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tablist = () => screen.getByRole("tablist", { name: "Pinned columns" });
const tabs = () => within(tablist()).getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(tablist()).getByRole("tab", { name });
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("Solutions status board dock (md and up)", () => {
  it("defaults to no dock and the active-work-first order: nothing is pinned until someone pins", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);
  });

  it("pinning a column docks it, opens the dock on it and leaves the rest in the scroller", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    expect(tabNames()).toEqual(["Shipped (2)"]);
    expect(tab(/^Shipped/)).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(headings(panel)).toEqual(["Shipped"]);
    expect(within(panel).getByText("Templates")).toBeInTheDocument();
    expect(scroller()).not.toContainElement(pinnedRegion());
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Killed"]);
  });

  it("two pinned columns share ONE dock; tabs follow column order and switching swaps the single panel", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    expect(screen.getAllByTestId("board-pinned-region")).toHaveLength(1);
    expect(tabNames()).toEqual(["Shipped (2)", "Killed (1)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Shipped"]);

    fireEvent.click(tab(/^Killed/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Killed"]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea"]);
  });

  it("clicking the active tab, or the panel's collapse button, collapses the dock to its rail", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    fireEvent.click(tab(/^Shipped/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tab(/^Shipped/)).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab(/^Shipped/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Collapse Shipped" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Shipped (2)"]);
  });

  it("unpinning the last column removes the dock and returns the column to the scroller in its order", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Shipped" }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);
  });

  it("reorders from the column menu, and the order is the layout's (the Columns popover moves the same order)", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "In delivery column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller()).slice(0, 3)).toEqual(["Validated", "In delivery", "Idea"]);
  });

  it("renders only the columns the page says are visible (hide stays with the popover) and never docks a hidden one", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false }),
    );
    render(<Board columnOrder={["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED"]} />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Shipped"]);
  });

  it("mirrors the layout to this browser's localStorage and restores it", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.pinnedColumnIds).toEqual(["SHIPPED"]);
    expect(stored.activePinnedId).toBe("SHIPPED");
    first.unmount();

    render(<Board />);
    expect(tabNames()).toEqual(["Shipped (2)"]);
    expect(within(screen.getByRole("tabpanel")).getByText("Templates")).toBeInTheDocument();
  });

  it("falls back to the default layout when the stored one is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const first = render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" }));
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);
  });

  it("makes each tab a drop target under the column's own droppable id data, and its panel keeps its cards draggable", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Shipped to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    // Both tabs sit in a drop wrapper; the open panel is Killed.
    expect(document.querySelectorAll("[data-slot=solution-dock-tab-drop]")).toHaveLength(2);
    expect(within(screen.getByRole("tabpanel")).getAllByLabelText("Drag to reorder")).toHaveLength(1);
  });
});

describe("Solutions status board dock below md", () => {
  beforeEach(() => setViewport(false));

  it("has no dock and no pin controls: every column is a scroller column", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);
  });

  it("keeps pinned state in the layout but renders pinned columns in the scroller in saved order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["KILLED", "SHIPPED", "IN_DELIVERY", "VALIDATED", "IDEA"], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Killed", "Shipped", "In delivery", "Validated", "Idea"]);
  });

  it("still allows reordering from the menu", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Killed column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move left" }));
    expect(headings(scroller()).slice(-2)).toEqual(["Killed", "Shipped"]);
  });
});

describe("Solutions grouped boards ignore pinning", () => {
  it("renders every group in the scroller with no dock and no layout controls, even when columns are pinned", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"], pinnedColumnIds: ["SHIPPED"], activePinnedId: "SHIPPED", dockCollapsed: false }),
    );
    render(<Board groupBy="opportunity" />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("board-column-menu")).not.toBeInTheDocument();
    expect(headings(screen.getByRole("region", { name: /grouped by opportunity/i }))).toEqual(["Opportunity A"]);
  });
});

describe("SolutionsColumnLayoutProvider", () => {
  function Probe() {
    const ctx = useSolutionsColumnLayoutContext();
    return <output data-testid="stored">{JSON.stringify(ctx?.stored ?? null)}</output>;
  }
  function Page({ columnLayout, version = "v1", id = "view-1" }: { columnLayout: unknown; version?: string; id?: string }) {
    return (
      <SolutionsColumnLayoutProvider workspaceId="w1" savedView={{ id, version, columnLayout }}>
        <Probe />
        <Board />
      </SolutionsColumnLayoutProvider>
    );
  }
  const saved = {
    columnOrder: ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"],
    pinnedColumnIds: ["SHIPPED"],
    activePinnedId: "SHIPPED",
    dockCollapsed: false,
  };

  it("starts from the saved view's layout, ignoring this browser's localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED" }));
    render(<Page columnLayout={saved} />);
    expect(tabNames()).toEqual(["Shipped (2)"]);
  });

  it("exposes the live layout for Save: null while default, the layout once changed, and leaves localStorage alone", () => {
    render(<Page columnLayout={undefined} />);
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Pin Idea to the right" }));
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toMatchObject({ pinnedColumnIds: ["IDEA"], activePinnedId: "IDEA" });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("starts from the layout a legacy columns.status.order describes", () => {
    const legacy = { columnOrder: ["KILLED", "IDEA", "IN_DELIVERY", "VALIDATED", "SHIPPED"], pinnedColumnIds: [] };
    render(<Page columnLayout={legacy} />);
    expect(headings(scroller())).toEqual(["Killed", "Idea", "In delivery", "Validated", "Shipped"]);
  });

  it("a corrupt saved layout degrades to the default", () => {
    render(<Page columnLayout={{ columnOrder: "nope" }} />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });
});
