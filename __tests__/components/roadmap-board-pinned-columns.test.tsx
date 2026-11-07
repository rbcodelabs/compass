// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  moveItem: vi.fn(),
  updateSortOrder: vi.fn(),
  promoteToRoadmap: vi.fn(),
  promoteFeedbackToRoadmap: vi.fn(),
  rescheduleRoadmapItem: vi.fn(),
  addRoadmapItem: vi.fn(),
  editRoadmapItem: vi.fn(),
  archiveRoadmapItem: vi.fn(),
  moveItemToLane: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/roadmap",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/roadmap/add-item-form", () => ({ AddItemForm: () => null }));

import { PanelProvider } from "@/components/panels/panel-context";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
import { RoadmapColumnLayoutProvider, useRoadmapColumnLayoutContext } from "@/components/roadmap/column-layout-context";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import type { UnscheduledItem } from "@/components/roadmap/unscheduled-items-panel";

const unscheduledItems: UnscheduledItem[] = [{ kind: "feedback", id: "fb-1", title: "Fix the broken export" }];
const STORAGE_KEY = "compass:roadmap-column-layout:ws-1";

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

function Board({ launch = true, items = [] as RoadmapCardData[] }: { launch?: boolean; items?: RoadmapCardData[] }) {
  return (
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <RoadmapBoard
        initialItems={items}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        launchWorkflowEnabled={launch}
        unscheduledItems={unscheduledItems}
      />
    </PanelProvider>
  );
}

const scroller = () => screen.getByRole("region", { name: "Roadmap board" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tabs = () => within(screen.getByRole("tablist", { name: "Pinned columns" })).getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(screen.getByRole("tablist", { name: "Pinned columns" })).getByRole("tab", { name });
// Column titles only (an empty column's empty state is also an h3).
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("RoadmapBoard dock (md and up)", () => {
  it("defaults to Not scheduled in the dock, collapsed to its tab rail, outside the scroller", () => {
    render(<Board />);
    expect(headings(scroller())).toEqual(["Now", "Next", "Later", "Launching", "Launched", "Shipped"]);
    const region = pinnedRegion()!;
    expect(scroller()).not.toContainElement(region);
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
    expect(tab(/^Not scheduled/)).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roadmap-unscheduled-column")).not.toBeInTheDocument();
  });

  it("clicking the tab opens the panel; clicking the active tab, or the panel's collapse button, closes it", () => {
    render(<Board />);
    fireEvent.click(tab(/^Not scheduled/));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByTestId("roadmap-unscheduled-column")).toBeInTheDocument();
    expect(within(panel).getByText("Fix the broken export")).toBeInTheDocument();
    expect(tab(/^Not scheduled/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/^Not scheduled/)).toHaveAttribute("aria-controls", panel.id);

    fireEvent.click(tab(/^Not scheduled/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();

    fireEvent.click(tab(/^Not scheduled/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Collapse Not scheduled" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tab(/^Not scheduled/)).toHaveFocus();
  });

  it("pinning a second column adds a tab to the SAME dock, makes it active and opens the dock; the panel shows only that column", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));

    expect(screen.getAllByTestId("board-pinned-region")).toHaveLength(1);
    expect(tabNames()).toEqual(["Later (0)", "Not scheduled (1)"]);
    expect(tab(/^Later/)).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
    expect(within(panel).queryByTestId("roadmap-unscheduled-column")).not.toBeInTheDocument();
    expect(within(scroller()).queryByTestId("roadmap-column-LATER")).not.toBeInTheDocument();
  });

  it("switching tabs swaps the panel; the dock is one column wide however many are pinned", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    expect(tabNames()).toEqual(["Next (0)", "Later (0)", "Not scheduled (1)"]);
    expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Next"]);

    fireEvent.click(tab(/^Not scheduled/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Not scheduled"]);
    expect(tab(/^Not scheduled/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/^Next/)).toHaveAttribute("aria-selected", "false");
    // Only one panel is ever rendered
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(headings(scroller())).toEqual(["Now", "Launching", "Launched", "Shipped"]);
  });

  it("unpinning the active column hands the panel to its neighbour; unpinning the last one removes the dock", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Later" }));
    expect(within(scroller()).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
    expect(tab(/^Not scheduled/)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Not scheduled" }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toContain("Later");
    expect(headings(scroller()).at(-1)).toBe("Not scheduled");
  });

  it("tabs are keyboard operable: roving tabindex, arrows/Home/End move focus, Enter activates", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    const [next, later, unscheduled] = tabs();
    expect([next, later, unscheduled].map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    next.focus();
    fireEvent.keyDown(next, { key: "ArrowDown" });
    expect(later).toHaveFocus();
    fireEvent.keyDown(later, { key: "End" });
    expect(unscheduled).toHaveFocus();
    fireEvent.keyDown(unscheduled, { key: "ArrowDown" });
    expect(next).toHaveFocus(); // wraps
    fireEvent.keyDown(next, { key: "ArrowUp" });
    expect(unscheduled).toHaveFocus();
    fireEvent.keyDown(unscheduled, { key: "Home" });
    expect(next).toHaveFocus();
    // Focus moving does not switch the panel; activating (a click, which Enter/Space produce on a button) does.
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Next"]);
    fireEvent.click(later);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Later"]);
  });

  it("reorders from the column menu (no drag needed), and disables moves at the ends", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Now column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller()).slice(0, 3)).toEqual(["Next", "Now", "Later"]);
  });

  it("Move left / right on a docked column reorders the tabs", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    expect(tabNames()).toEqual(["Next (0)", "Later (0)", "Not scheduled (1)"]);
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Next column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    expect(tabNames()).toEqual(["Later (0)", "Next (0)", "Not scheduled (1)"]);
    expect(tab(/^Next/)).toHaveAttribute("aria-selected", "true"); // still the active tab
    expect(headings(scroller())).toEqual(["Now", "Launching", "Launched", "Shipped"]);
  });

  it("does not offer moves across a hidden launch column", async () => {
    render(<Board launch={false} />);
    expect(headings(scroller())).toEqual(["Now", "Next", "Later", "Shipped"]);
    fireEvent.click(screen.getByRole("button", { name: "Later column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller())).toEqual(["Now", "Next", "Shipped", "Later"]);
  });

  it("mirrors layout changes to this browser's localStorage and restores them on the next visit", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.pinnedColumnIds).toEqual(["unscheduled", "LATER"]);
    expect(stored.activePinnedId).toBe("LATER");
    expect(stored.dockCollapsed).toBe(false);
    first.unmount();

    render(<Board />);
    expect(tabNames()).toEqual(["Later (0)", "Not scheduled (1)"]);
    expect(within(screen.getByRole("tabpanel")).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
  });

  it("falls back to the default layout when the stored one is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const first = render(<Board />);
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    first.unmount();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" }));
    render(<Board />);
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
  });

  it("tolerates an older stored layout (per-column collapsed ids): same pins, dock starts collapsed", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"], pinnedColumnIds: ["unscheduled", "LATER"], collapsedColumnIds: ["LATER"] }),
    );
    render(<Board />);
    expect(tabNames()).toEqual(["Later (0)", "Not scheduled (1)"]);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("drops unknown ids from a stale stored layout and appends the columns it did not know about", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: ["SHIPPED", "GONE", "NOW"], pinnedColumnIds: ["GONE", "NOW"] }));
    render(<Board />);
    expect(tabNames()).toEqual(["Now (0)", "Not scheduled (1)"]); // Not scheduled is new to that layout: default pinned
    expect(headings(scroller())).toEqual(["Shipped", "Next", "Later", "Launching", "Launched"]);
  });
});

describe("RoadmapBoard dock below md", () => {
  beforeEach(() => setViewport(false));

  it("falls back to ordinary scroller columns: no dock, Not scheduled is the last swipe column, no pin controls", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(scroller()).getByTestId("roadmap-unscheduled-column")).toBeInTheDocument();
    expect(headings(scroller()).at(-1)).toBe("Not scheduled");
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse Not scheduled" })).not.toBeInTheDocument();
  });

  it("keeps pinned state in the layout but renders it in the scroller, in column order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"], pinnedColumnIds: ["unscheduled", "NOW"] }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())[0]).toBe("Now");
  });

  it("still allows reordering from the menu", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Not scheduled column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move left" }));
    const order = headings(scroller());
    expect(order.indexOf("Not scheduled")).toBe(order.length - 2);
  });
});

describe("RoadmapColumnLayoutProvider with a saved view", () => {
  function Probe() {
    const ctx = useRoadmapColumnLayoutContext();
    return <output data-testid="stored">{JSON.stringify(ctx?.stored ?? null)}</output>;
  }
  function Page({ columnLayout, version = "v1", id = "view-1" }: { columnLayout: unknown; version?: string; id?: string }) {
    return (
      <RoadmapColumnLayoutProvider workspaceId="ws-1" savedView={{ id, version, columnLayout }}>
        <Probe />
        <Board />
      </RoadmapColumnLayoutProvider>
    );
  }
  const savedLayout = {
    columnOrder: ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"],
    pinnedColumnIds: ["unscheduled", "LATER"],
    activePinnedId: "LATER",
    dockCollapsed: false,
  };

  it("starts from the saved view's layout, ignoring this browser's localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedLayout, pinnedColumnIds: ["NOW"] }));
    render(<Page columnLayout={savedLayout} />);
    expect(tabNames()).toEqual(["Later (0)", "Not scheduled (1)"]);
    expect(within(screen.getByRole("tabpanel")).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
  });

  it("exposes the live layout for the save menu: absent while default, the layout once changed, and does not touch localStorage", () => {
    render(<Page columnLayout={undefined} />);
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Pin Now to the right" }));
    const stored = JSON.parse(screen.getByTestId("stored").textContent!);
    expect([...stored.pinnedColumnIds].sort()).toEqual(["NOW", "unscheduled"]);
    expect(stored.activePinnedId).toBe("NOW");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("opening or switching the dock is part of the layout (so Save captures it, and it is 'modified')", () => {
    render(<Page columnLayout={undefined} />);
    fireEvent.click(tab(/^Not scheduled/));
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toMatchObject({ dockCollapsed: false, activePinnedId: "unscheduled" });
  });

  it("a corrupt saved layout degrades to the default layout", () => {
    render(<Page columnLayout={{ columnOrder: "nope" }} />);
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });

  it("resets to the stored layout when the view changes or is saved (new version), but keeps edits across re-renders of the same version", () => {
    const { rerender } = render(<Page columnLayout={savedLayout} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    rerender(<Page columnLayout={savedLayout} />);
    expect(tabNames()).toEqual(["Next (0)", "Later (0)", "Not scheduled (1)"]);

    const next = { ...savedLayout, pinnedColumnIds: ["unscheduled", "LATER", "NEXT"], activePinnedId: "NEXT" };
    act(() => rerender(<Page columnLayout={next} version="v2" />));
    expect(JSON.parse(screen.getByTestId("stored").textContent!).pinnedColumnIds).toEqual(["unscheduled", "LATER", "NEXT"]);

    act(() => rerender(<Page columnLayout={undefined} id="view-2" />));
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    expect(tabNames()).toEqual(["Not scheduled (1)"]);
  });
});
