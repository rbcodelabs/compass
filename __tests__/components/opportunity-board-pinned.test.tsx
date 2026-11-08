// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { OpportunityBoard } from "@/components/discovery/opportunity-board";
import { OpportunitiesColumnLayoutProvider, useOpportunitiesColumnLayoutContext } from "@/components/discovery/discovery-column-layout";
import type { OpportunityCardData } from "@/components/discovery/opportunity-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }));
vi.mock("@/components/discovery/new-opportunity-button", () => ({ NewOpportunityButton: () => null }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  updateOpportunityStatus: vi.fn(),
  archiveOpportunity: vi.fn(),
  moveOpportunity: vi.fn(),
  reorderOpportunity: vi.fn(), reorderOpportunitiesInColumn: vi.fn(),
  createOpportunity: vi.fn(),
}));

const STORAGE_KEY = "compass:discovery-column-layout:w1";

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

function card(id: string, title: string, status: OpportunityCardData["status"], sortOrder = 0, normalizedScore?: number): OpportunityCardData {
  return {
    id,
    title,
    customerSegment: null,
    status,
    sortOrder,
    _count: { solutions: 0, evidence: 0 },
    squad: null,
    score: normalizedScore === undefined ? null : { normalizedScore, modelVersion: 1, liveModelVersion: 1, stale: false },
  };
}

const BY_STATUS = {
  EXPLORING: [card("e1", "Wizard", "EXPLORING", 0), card("e2", "Templates", "EXPLORING", 1)],
  VALIDATING: [card("v1", "Checklist", "VALIDATING")],
  PRIORITIZED: [],
  ACTIVE: [card("a1", "Onboarding", "ACTIVE", 0, 10), card("a2", "Billing", "ACTIVE", 1, 90)],
  UNREVIEWED: [],
  ARCHIVED: [],
};

function Board(props: Partial<React.ComponentProps<typeof OpportunityBoard>> = {}) {
  return <OpportunityBoard opportunitiesByStatus={BY_STATUS} orgSlug="org" workspaceSlug="ws" workspaceId="w1" {...props} />;
}

const scroller = () => screen.getByRole("region", { name: "Opportunity board" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tablist = () => screen.getByRole("tablist", { name: "Pinned columns" });
const tabs = () => within(tablist()).getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(tablist()).getByRole("tab", { name });
// The column title carries a status-definition hint (an info button); only the name counts here.
const headings = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("section > header h3")).map((h) => {
    const copy = h.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-slot=tooltip-trigger]").forEach((node) => node.remove());
    return copy.textContent?.replace(/hidden in view, has cards/, "").trim();
  });
const cardTitles = (el: HTMLElement) => Array.from(el.querySelectorAll("[data-flip-id] button:not([aria-label])")).map((b) => b.textContent).filter((t) => t && t.length > 1 && !/^\d/.test(t));

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("Opportunities status board dock (md and up)", () => {
  it("defaults to no dock and the Active-first order: nothing is pinned until someone pins", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating", "Exploring", "Unreviewed"]);
  });

  it("pinning a column docks it, opens the dock on it and leaves the rest in the scroller", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    expect(tabNames()).toEqual(["Exploring (2)"]);
    expect(tab(/^Exploring/)).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(headings(panel)).toEqual(["Exploring"]);
    expect(within(panel).getByText("Templates")).toBeInTheDocument();
    expect(scroller()).not.toContainElement(pinnedRegion());
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating", "Unreviewed"]);
  });

  it("two pinned columns share ONE dock; tabs follow column order and switching swaps the single panel", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Validating to the right" }));
    expect(screen.getAllByTestId("board-pinned-region")).toHaveLength(1);
    expect(tabNames()).toEqual(["Validating (1)", "Exploring (2)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Validating"]);

    fireEvent.click(tab(/^Exploring/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Exploring"]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Unreviewed"]);
  });

  it("clicking the active tab, or the panel's collapse button, collapses the dock to its rail", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    fireEvent.click(tab(/^Exploring/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    fireEvent.click(tab(/^Exploring/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Collapse Exploring" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Exploring (2)"]);
  });

  it("unpinning the last column removes the dock and returns the column to the scroller in its order", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Exploring" }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating", "Exploring", "Unreviewed"]);
  });

  it("reorders from the column menu (the layout's order, which the Columns popover moves too)", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Active column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller())).toEqual(["Prioritized", "Active", "Validating", "Exploring", "Unreviewed"]);
  });

  it("renders only the columns the page says are visible (hide stays with the popover) and never docks a hidden one", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING", "UNREVIEWED"], pinnedColumnIds: ["EXPLORING"], activePinnedId: "EXPLORING", dockCollapsed: false }),
    );
    render(<Board columnOrder={["ACTIVE", "PRIORITIZED", "VALIDATING"]} />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating"]);
  });

  it("mirrors the layout to this browser's localStorage and restores it", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.pinnedColumnIds).toEqual(["EXPLORING"]);
    expect(stored.activePinnedId).toBe("EXPLORING");
    first.unmount();

    render(<Board />);
    expect(tabNames()).toEqual(["Exploring (2)"]);
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
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating", "Exploring", "Unreviewed"]);
  });

  it("makes each tab a drop target, and the open panel keeps its cards draggable and sortable", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Validating to the right" }));
    expect(document.querySelectorAll("[data-slot=opportunity-dock-tab-drop]")).toHaveLength(2);
    fireEvent.click(tab(/^Exploring/));
    // Two cards in the open panel, each with its own drag handle (in-column ordering needs every card sortable).
    expect(within(screen.getByRole("tabpanel")).getAllByLabelText("Drag to reorder")).toHaveLength(2);
    // The panel is the column's own `column-EXPLORING` drop target.
    expect(screen.getByRole("tabpanel").querySelector("[data-slot=opportunity-board-column]")).toHaveAttribute("data-status", "EXPLORING");
  });

  it("scroller columns keep their sortable cards when a dock exists", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Exploring to the right" }));
    const active = scroller().querySelector("[data-status=ACTIVE]") as HTMLElement;
    expect(within(active).getAllByLabelText("Drag to reorder")).toHaveLength(2);
    expect(cardTitles(active)).toEqual(["Onboarding", "Billing"]);
  });

  it("sort by score orders scroller AND docked columns by score and turns dragging off in both", () => {
    render(<Board hasActiveScoringModel sortByScore />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Active to the right" }));
    const panel = screen.getByRole("tabpanel");
    expect(cardTitles(panel)).toEqual(["Billing", "Onboarding"]);
    expect(within(panel).queryAllByLabelText("Drag to reorder")).toHaveLength(0);
    expect(screen.queryAllByLabelText("Drag to reorder")).toHaveLength(0);
  });
});

describe("Opportunities status board dock below md", () => {
  beforeEach(() => setViewport(false));

  it("has no dock and no pin controls: every column is a scroller column", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Active", "Prioritized", "Validating", "Exploring", "Unreviewed"]);
  });

  it("keeps pinned state in the layout but renders pinned columns in the scroller in saved order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["EXPLORING", "ACTIVE", "PRIORITIZED", "VALIDATING"], pinnedColumnIds: ["EXPLORING"], activePinnedId: "EXPLORING", dockCollapsed: false }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Exploring", "Active", "Prioritized", "Validating", "Unreviewed"]);
  });

  it("still allows reordering from the menu", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Exploring column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move left" }));
    expect(headings(scroller()).slice(2, 4)).toEqual(["Exploring", "Validating"]);
  });
});

describe("OpportunitiesColumnLayoutProvider", () => {
  function Probe() {
    const ctx = useOpportunitiesColumnLayoutContext();
    return <output data-testid="stored">{JSON.stringify(ctx?.stored ?? null)}</output>;
  }
  function Page({ columnLayout, version = "v1", id = "view-1" }: { columnLayout: unknown; version?: string; id?: string }) {
    return (
      <OpportunitiesColumnLayoutProvider workspaceId="w1" savedView={{ id, version, columnLayout }}>
        <Probe />
        <Board />
      </OpportunitiesColumnLayoutProvider>
    );
  }
  const saved = {
    columnOrder: ["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING", "UNREVIEWED"],
    pinnedColumnIds: ["EXPLORING"],
    activePinnedId: "EXPLORING",
    dockCollapsed: false,
  };

  it("starts from the saved view's layout, ignoring this browser's localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, pinnedColumnIds: ["VALIDATING"], activePinnedId: "VALIDATING" }));
    render(<Page columnLayout={saved} />);
    expect(tabNames()).toEqual(["Exploring (2)"]);
  });

  it("exposes the live layout for Save: null while default, the layout once changed, and leaves localStorage alone", () => {
    render(<Page columnLayout={undefined} />);
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Pin Validating to the right" }));
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toMatchObject({ pinnedColumnIds: ["VALIDATING"], activePinnedId: "VALIDATING" });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("starts from the layout a legacy columns.status.order describes", () => {
    const legacy = { columnOrder: ["EXPLORING", "VALIDATING", "ACTIVE", "PRIORITIZED", "UNREVIEWED"], pinnedColumnIds: [] };
    render(<Page columnLayout={legacy} />);
    expect(headings(scroller())).toEqual(["Exploring", "Validating", "Active", "Prioritized", "Unreviewed"]);
  });

  it("a corrupt saved layout degrades to the default", () => {
    render(<Page columnLayout={{ columnOrder: "nope" }} />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });
});
