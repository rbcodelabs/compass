// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(); }} {...rest}>{children}</a>
  ),
}));

import { AgentBoard } from "@/components/agent/agent-board";
import type { AgentBoardCard } from "@/lib/agent-board";

const STORAGE_KEY = "compass:agent-board-column-layout:w1";
const NOW = "2026-06-01T12:00:00Z";

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

function card(id: string, title: string, runStatus: string | null, messageCount = 1, reviewedAt: string | null = null): AgentBoardCard {
  return { id, title, messageCount, runStatus, lastActivityAt: NOW, reviewedAt };
}

// working, new (unreviewed) and failed have cards; done and ready are empty (so hidden).
const baseCards = [
  card("c1", "Summarise feedback", "RUNNING"),
  card("c2", "Draft the spec", "SUCCEEDED"),
  card("c3", "Broken export", "FAILED"),
];

let cardsFromServer: AgentBoardCard[] = baseCards;
const fetchMock = vi.fn();
const onOpen = vi.fn();

function Board({ initial = baseCards }: { initial?: AgentBoardCard[] }) {
  return <AgentBoard workspaceId="w1" basePath="/org/ws" initialCards={initial} onOpenConversation={onOpen} />;
}

const scroller = () => screen.getByRole("region", { name: "Agent conversations by status" });
const pinnedRegion = () => screen.queryByTestId("board-pinned-region");
const tablist = () => screen.getByRole("tablist", { name: "Pinned columns" });
const tabNames = () => within(tablist()).getAllByRole("tab").map((t) => t.getAttribute("aria-label"));
const tab = (name: RegExp | string) => within(tablist()).getByRole("tab", { name });
const headings = (el: HTMLElement) => Array.from(el.querySelectorAll("section > header h3")).map((h) => h.textContent);

beforeEach(() => {
  window.localStorage.clear();
  setViewport(true);
  cardsFromServer = baseCards;
  onOpen.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ cards: cardsFromServer }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agent board dock (md and up)", () => {
  it("defaults to no dock, with empty Done and Ready hidden as before", () => {
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Working", "New", "Failed"]);
  });

  it("pins a column into the dock and its cards still link to the conversation", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Failed to the right" }));
    expect(tabNames()).toEqual(["Failed (1)"]);
    const panel = screen.getByRole("tabpanel");
    expect(headings(panel)).toEqual(["Failed"]);
    const link = within(panel).getByRole("link", { name: /Broken export/ });
    expect(link).toHaveAttribute("href", "/org/ws/agent?c=c3");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("c3");
    expect(headings(scroller())).toEqual(["Working", "New"]);
  });

  it("two pinned columns share ONE dock and switching tabs swaps the panel", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Failed to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Working to the right" }));
    expect(tabNames()).toEqual(["Working (1)", "Failed (1)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Working"]);
    fireEvent.click(tab(/^Failed/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Failed"]);
    fireEvent.click(tab(/^Failed/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Working (1)", "Failed (1)"]);
  });

  it("tabs are not drop targets (the board is read-only)", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Failed to the right" }));
    expect(document.querySelector("[data-slot$=dock-tab-drop]")).toBeNull();
  });

  it("reorders from the column menu and mirrors the layout to localStorage", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Working column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    expect(headings(scroller())).toEqual(["New", "Working", "Failed"]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).columnOrder.slice(0, 2)).toEqual(["new", "working"]);
  });

  it("restores a stored layout, and degrades a corrupt one to the defaults", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ columnOrder: ["working", "new", "done", "failed", "ready"], pinnedColumnIds: ["failed"], activePinnedId: "failed", dockCollapsed: false }));
    const first = render(<Board />);
    expect(tabNames()).toEqual(["Failed (1)"]);
    first.unmount();
    window.localStorage.setItem(STORAGE_KEY, "{nope");
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Working", "New", "Failed"]);
  });
});

describe("Agent board: columns hidden because they are empty", () => {
  const pinnedEmpty = JSON.stringify({
    columnOrder: ["working", "new", "done", "failed", "ready"],
    pinnedColumnIds: ["done"],
    activePinnedId: "done",
    dockCollapsed: false,
  });

  it("a pinned empty column keeps its pin but is filtered out of the dock and scroller, and returns with its first card", async () => {
    window.localStorage.setItem(STORAGE_KEY, pinnedEmpty);
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Working", "New", "Failed"]);

    // a conversation gets reviewed: Done now has a card, and its tab appears, already pinned
    cardsFromServer = [...baseCards, card("c4", "Reviewed chat", "SUCCEEDED", 2, "2026-06-02T00:00:00Z")];
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(tabNames()).toEqual(["Done (1)"]));
    expect(within(screen.getByRole("tabpanel")).getByText("Reviewed chat")).toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Working", "New", "Failed"]);

    // and it empties again: the tab goes away, the pin is still stored
    cardsFromServer = baseCards;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(pinnedRegion()).not.toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).pinnedColumnIds).toEqual(["done"]);
  });

  it("falls back to another docked tab while the stored active column is hidden", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["working", "new", "done", "failed", "ready"], pinnedColumnIds: ["done", "failed"], activePinnedId: "done", dockCollapsed: false }),
    );
    render(<Board />);
    expect(tabNames()).toEqual(["Failed (1)"]);
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Failed"]);
  });

  it("Working and New are always shown, even when empty and pinned", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["working", "new", "done", "failed", "ready"], pinnedColumnIds: ["working"], activePinnedId: "working", dockCollapsed: false }),
    );
    render(<Board initial={[]} />);
    expect(tabNames()).toEqual(["Working (0)"]);
    expect(headings(scroller())).toEqual(["New"]);
  });
});

describe("Agent board polling", () => {
  it("a poll that changes the cards keeps the layout, the open tab and the pinned order", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Failed to the right" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Working to the right" }));
    fireEvent.click(tab(/^Failed/));
    expect(headings(screen.getByRole("tabpanel"))).toEqual(["Failed"]);
    const stored = window.localStorage.getItem(STORAGE_KEY);

    cardsFromServer = [...baseCards, card("c5", "Second failure", "FAILED")];
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(tabNames()).toEqual(["Working (1)", "Failed (2)"]));
    expect(tab(/^Failed/)).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).getByText("Second failure")).toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(stored);
  });

  it("an unchanged poll does not disturb a collapsed dock", async () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Failed to the right" }));
    fireEvent.click(tab(/^Failed/));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    const calls = fetchMock.mock.calls.length;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Failed (1)"]);
  });
});

describe("Agent board dock below md", () => {
  beforeEach(() => setViewport(false));

  it("has no dock and no pin controls; pinned columns render in the scroller in saved order, keeping snap sizing", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columnOrder: ["failed", "working", "new", "done", "ready"], pinnedColumnIds: ["failed"], activePinnedId: "failed", dockCollapsed: false }),
    );
    render(<Board />);
    expect(pinnedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pin .* to the right$/ })).not.toBeInTheDocument();
    expect(headings(scroller())).toEqual(["Failed", "Working", "New"]);
    expect(document.querySelector<HTMLElement>('[data-board-column="new"]')!.className).toContain("w-[calc(100cqw-3.5rem)]");
  });
});
