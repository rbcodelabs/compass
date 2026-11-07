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
// Column titles only (an empty column's empty state is also an h3).
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("RoadmapBoard pinned columns (md and up)", () => {
  it("defaults to Not scheduled pinned on the right, collapsed to a tab, outside the scroller", () => {
    render(<Board />);
    expect(headings(scroller())).toEqual(["Now", "Next", "Later", "Launching", "Launched", "Shipped"]);
    const region = pinnedRegion()!;
    expect(region).toBeInTheDocument();
    expect(scroller()).not.toContainElement(region);
    const tab = within(region).getByRole("button", { name: "Expand Not scheduled (1)" });
    expect(tab).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("roadmap-unscheduled-column")).not.toBeInTheDocument();
  });

  it("expands and collapses the pinned Not scheduled column", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Not scheduled (1)" }));
    const column = within(pinnedRegion()!).getByTestId("roadmap-unscheduled-column");
    expect(within(column).getByText("Fix the broken export")).toBeInTheDocument();
    fireEvent.click(within(column).getByRole("button", { name: "Collapse Not scheduled" }));
    expect(screen.queryByTestId("roadmap-unscheduled-column")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();
  });

  it("pins a second column (Later) into the docked region, outside the scroller, and unpins it back", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));

    const region = pinnedRegion()!;
    expect(within(region).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
    expect(within(scroller()).queryByTestId("roadmap-column-LATER")).not.toBeInTheDocument();
    // two docked columns: Later (open) and the Not scheduled tab, in column order
    expect(within(region).getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: "Unpin Later" }));
    expect(within(scroller()).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
    expect(headings(scroller())).toContain("Later");
  });

  it("collapses a pinned horizon to a tab with its count and expands it again", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(within(pinnedRegion()!).getByRole("button", { name: "Collapse Later" }));

    const tab = within(pinnedRegion()!).getByRole("button", { name: "Expand Later (0)" });
    expect(tab).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("roadmap-column-LATER")).not.toBeInTheDocument();

    fireEvent.click(tab);
    expect(within(pinnedRegion()!).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
  });

  it("reorders from the column menu (keyboard-accessible, no drag needed), and disables moves at the ends", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Now column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller()).slice(0, 3)).toEqual(["Next", "Now", "Later"]);
  });

  it("moves a pinned column among the pinned ones only", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    // Docked, in column order: Next, Later, Not scheduled (tab)
    expect(headings(pinnedRegion()!)).toEqual(["Next", "Later"]);
    fireEvent.click(within(pinnedRegion()!).getByRole("button", { name: "Next column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    expect(headings(pinnedRegion()!)).toEqual(["Later", "Next"]);
    // The scroller is untouched
    expect(headings(scroller())).toEqual(["Now", "Launching", "Launched", "Shipped"]);
  });

  it("does not offer moves across a hidden launch column", async () => {
    render(<Board launch={false} />);
    expect(headings(scroller())).toEqual(["Now", "Next", "Later", "Shipped"]);
    fireEvent.click(screen.getByRole("button", { name: "Later column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    // Later swaps with Shipped (the next VISIBLE column), not with the hidden Launching
    expect(headings(scroller())).toEqual(["Now", "Next", "Shipped", "Later"]);
  });

  it("mirrors layout changes to this browser's localStorage and restores them on the next visit", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Later to the right" }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).pinnedColumnIds).toEqual(["unscheduled", "LATER"]);
    first.unmount();

    render(<Board />);
    expect(within(pinnedRegion()!).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
  });

  it("falls back to the default layout when the stored one is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const first = render(<Board />);
    expect(screen.getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();
    expect(headings(scroller())).toContain("Later");
    first.unmount();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" }));
    render(<Board />);
    expect(screen.getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();
    expect(headings(scroller())).toContain("Later");
  });

  it("drops unknown ids from a stale stored layout and appends the columns it did not know about", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["SHIPPED", "GONE", "NOW"], pinnedColumnIds: ["GONE", "NOW"], collapsedColumnIds: [] }),
    );
    render(<Board />);
    expect(headings(pinnedRegion()!)).toEqual(["Now"]);
    // Saved order first (Shipped, Now), then the columns it never mentioned, in default order.
    expect(headings(scroller())).toEqual(["Shipped", "Next", "Later", "Launching", "Launched"]);
  });
});

describe("RoadmapBoard pinned columns below md", () => {
  beforeEach(() => setViewport(false));

  it("falls back to ordinary scroller columns: no pinned region, Not scheduled is the last swipe column, no pin controls", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    const column = within(scroller()).getByTestId("roadmap-unscheduled-column");
    expect(column).toBeInTheDocument();
    expect(headings(scroller()).at(-1)).toBe("Not scheduled");
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse Not scheduled" })).not.toBeInTheDocument();
  });

  it("keeps pinned state in the layout but renders it in the scroller, in column order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"], pinnedColumnIds: ["unscheduled", "NOW"], collapsedColumnIds: [] }),
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
    collapsedColumnIds: [],
  };

  it("starts from the saved view's layout, ignoring this browser's localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedLayout, pinnedColumnIds: ["NOW"] }));
    render(<Page columnLayout={savedLayout} />);
    expect(within(pinnedRegion()!).getByTestId("roadmap-column-LATER")).toBeInTheDocument();
    expect(within(pinnedRegion()!).getByTestId("roadmap-unscheduled-column")).toBeInTheDocument(); // saved layout says expanded
    expect(screen.queryByTestId("roadmap-column-NOW")?.closest('[data-testid="board-pinned-region"]')).toBeNull();
  });

  it("exposes the live layout for the save menu: absent while default, the layout once changed, and does not touch localStorage", () => {
    render(<Page columnLayout={undefined} />);
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Pin Now to the right" }));
    const stored = JSON.parse(screen.getByTestId("stored").textContent!);
    expect([...stored.pinnedColumnIds].sort()).toEqual(["NOW", "unscheduled"]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("a corrupt saved layout degrades to the default layout", () => {
    render(<Page columnLayout={{ columnOrder: "nope" }} />);
    expect(screen.getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });

  it("resets to the stored layout when the view changes or is saved (new version), but keeps edits across re-renders of the same version", () => {
    const { rerender } = render(<Page columnLayout={savedLayout} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Next to the right" }));
    rerender(<Page columnLayout={savedLayout} />);
    expect(within(pinnedRegion()!).getByTestId("roadmap-column-NEXT")).toBeInTheDocument();

    const next = { ...savedLayout, pinnedColumnIds: ["unscheduled", "LATER", "NEXT"] };
    act(() => rerender(<Page columnLayout={next} version="v2" />));
    expect(JSON.parse(screen.getByTestId("stored").textContent!).pinnedColumnIds).toEqual(["unscheduled", "LATER", "NEXT"]);

    act(() => rerender(<Page columnLayout={undefined} id="view-2" />));
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    expect(screen.getByRole("button", { name: "Expand Not scheduled (1)" })).toBeInTheDocument();
  });
});
