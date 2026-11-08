// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({
  moveExperiment: vi.fn(),
  reorderExperiment: vi.fn(),
  archiveExperiment: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/org/ws/experiments",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
import { ExperimentBoard } from "@/components/experiments/experiment-board";
import type { ExperimentCardData } from "@/components/experiments/experiment-card";

const STORAGE_KEY = "compass:experiments-column-layout:w1";

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

function experiment(id: string, title: string, status: ExperimentCardData["status"]): ExperimentCardData {
  return { id, title, hypothesis: `We believe ${title}`, killCondition: "", status, sortOrder: 0, conclusion: null };
}

const experiments = [
  experiment("e1", "Pricing page", "DESIGNING"),
  experiment("e2", "Onboarding tour", "RUNNING"),
  experiment("e3", "Dark mode", "KILLED"),
  experiment("e4", "Old banner", "KILLED"),
];

function Board() {
  return (
    <PanelProvider orgSlug="org" workspaceSlug="ws">
      <ExperimentBoard experiments={experiments} workspaceId="w1" orgSlug="org" workspaceSlug="ws" />
    </PanelProvider>
  );
}

const scroller = () => screen.getByRole("region", { name: "Experiment board" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tablist = () => screen.getByRole("tablist", { name: "Pinned columns" });
const tabNames = () => within(tablist()).getAllByRole("tab").map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(tablist()).getByRole("tab", { name });
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);
const DEFAULT_ORDER = ["Designing", "Running", "Complete", "Killed"];

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
});
afterEach(() => cleanup());

describe("Experiments board dock (md and up)", () => {
  it("defaults to no dock and the lifecycle order", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("pinning a column docks it, opens the dock on it and leaves the rest in the scroller", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    expect(tabNames()).toEqual(["Killed (2)"]);
    expect(tab(/^Killed/)).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(headings(panel)).toEqual(["Killed"]);
    expect(within(panel).getByText("Dark mode")).toBeInTheDocument();
    expect(scroller()).not.toContainElement(pinnedRegion());
    expect(headings(scroller())).toEqual(["Designing", "Running", "Complete"]);
  });

  it("two pinned columns share ONE dock; tabs follow column order and switching swaps the single panel", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Running to the right" }));
    expect(screen.getAllByTestId("board-pinned-region")).toHaveLength(1);
    expect(tabNames()).toEqual(["Running (1)", "Killed (2)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Running"]);
    fireEvent.click(tab(/^Killed/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Killed"]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("collapses via the active tab or the panel's button, and unpinning the last column removes the dock", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    fireEvent.click(tab(/^Killed/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    fireEvent.click(tab(/^Killed/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Collapse Killed" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    fireEvent.click(tab(/^Killed/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Unpin Killed" }));
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("reorders from the column menu; the layout's order is the only column order", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Designing column options" }));
    expect(await screen.findByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller())).toEqual(["Running", "Designing", "Complete", "Killed"]);
  });

  it("the open docked panel keeps its cards draggable, and each tab is a drop target", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Running to the right" }));
    expect(within(screen.getByRole("tabpanel")).getAllByLabelText("Drag to reorder")).toHaveLength(1);
    expect(document.querySelectorAll("[data-slot=experiment-dock-tab-drop]")).toHaveLength(2);
  });

  it("mirrors the layout to this browser's localStorage and restores it", () => {
    const first = render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Killed to the right" }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).pinnedColumnIds).toEqual(["KILLED"]);
    first.unmount();
    render(<Board />);
    expect(tabNames()).toEqual(["Killed (2)"]);
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

describe("Experiments board dock below md", () => {
  beforeEach(() => setViewport(false));

  it("has no dock and no pin controls: every column is a scroller column", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(DEFAULT_ORDER);
  });

  it("keeps pinned state in the layout but renders pinned columns in the scroller in saved order", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["KILLED", "DESIGNING", "RUNNING", "COMPLETE"], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Killed", "Designing", "Running", "Complete"]);
  });

  it("keeps the mobile snap-column sizing on scroller columns", () => {
    render(<Board />);
    const column = document.querySelector<HTMLElement>('[data-experiment-column="RUNNING"]')!;
    expect(column.className).toContain("w-[calc(100cqw-1.5rem)]");
  });
});
