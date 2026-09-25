// @vitest-environment jsdom

/**
 * How PanelShell hosts the "New feedback" composer (`?detail=feedback-new:new`).
 *
 * The composer docks as a column on wide viewports regardless of the pin
 * preference — the board has to stay usable beside it — and that docking
 * persists for the rest of the panel session so the hand-off to the created
 * item's detail panel does not jump from a column to a modal sheet. None of
 * this may touch the user's saved pin preference.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PANEL_WIDTH_DEFAULT } from "@/lib/panel-pin";

const closePanel = vi.fn();
let panelState: { type: string; id: string } | null = { type: "feedback-new", id: "new" };

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    panel: panelState,
    closePanel,
    openPanel: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
  }),
}));

vi.mock("@/components/feedback/feedback-composer", () => ({
  FeedbackComposer: () => (
    <div data-testid="composer-body">
      <input aria-label="Title" />
      {createPortal(<button data-testid="portalled">Keep editing</button>, document.body)}
    </div>
  ),
}));
vi.mock("@/components/panels/feedback-panel", () => ({
  FeedbackPanel: ({ id }: { id: string }) => <div data-testid="feedback-body">{id}</div>,
}));
vi.mock("@/components/panels/objective-panel", () => ({ ObjectivePanel: () => null }));
vi.mock("@/components/panels/key-result-panel", () => ({ KeyResultPanel: () => null }));
vi.mock("@/components/panels/opportunity-panel", () => ({
  OpportunityPanel: ({ opportunityId }: { opportunityId: string }) => <div data-testid="opportunity-body">{opportunityId}</div>,
}));
vi.mock("@/components/discovery/opportunity-composer", () => ({
  OpportunityComposer: ({ composerId }: { composerId: string }) => (
    <div data-testid="opportunity-composer-body">{composerId}</div>
  ),
}));
vi.mock("@/components/panels/solution-panel", () => ({ SolutionPanel: () => null }));
vi.mock("@/components/panels/assumption-panel", () => ({ AssumptionPanel: () => null }));
vi.mock("@/components/panels/experiment-panel", () => ({ ExperimentPanel: () => null }));
vi.mock("@/components/panels/roadmap-item-panel", () => ({ RoadmapItemPanel: () => null }));
vi.mock("@/components/panels/discovery-rail-panel", () => ({ DiscoveryRailPanel: () => null }));
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: () => null }));

import { PanelShell } from "@/components/panels/panel-shell";

function setViewportAllowsPin(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function readPinCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)compass_panel_detail=([^;]*)/);
  return match ? match[1] : null;
}

const aside = () => document.querySelector('[data-slot="pinned-panel"]') as HTMLElement | null;
const unpinned = { pinned: false, width: PANEL_WIDTH_DEFAULT };

beforeEach(() => {
  panelState = { type: "feedback-new", id: "new" };
  closePanel.mockClear();
  document.cookie = "compass_panel_detail=; Path=/; Max-Age=0";
  setViewportAllowsPin(true);
});

afterEach(() => {
  cleanup();
  document.cookie = "compass_panel_detail=; Path=/; Max-Age=0";
});

describe("PanelShell — feedback composer", () => {
  it("docks the composer as a column for an unpinned user on a wide viewport", () => {
    render(<PanelShell initialPin={unpinned} />);
    expect(aside()).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "New feedback" })).toBeInTheDocument();
    expect(screen.getByTestId("composer-body")).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
    // Pinning is meaningless while composing — the column is already docked.
    expect(screen.queryByRole("button", { name: /Pin panel|Unpin panel/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeInTheDocument();
  });

  it("falls back to a full-width sheet below the pin breakpoint", async () => {
    setViewportAllowsPin(false);
    render(<PanelShell initialPin={unpinned} />);
    expect(aside()).toBeNull();
    const sheet = await screen.findByTestId("composer-body", {}, { timeout: 2000 });
    const content = sheet.closest('[data-slot="sheet-content"]');
    expect(content).not.toBeNull();
    expect(content).toHaveClass("w-full", "sm:max-w-xl");
  });

  it("keeps the created item docked after the hand-off, then restores the preference once closed", () => {
    const { rerender } = render(<PanelShell initialPin={unpinned} />);
    expect(aside()).not.toBeNull();

    panelState = { type: "feedback", id: "fb-1" };
    rerender(<PanelShell initialPin={unpinned} />);
    expect(aside()).not.toBeNull();
    expect(screen.getByTestId("feedback-body")).toHaveTextContent("fb-1");
    // A normal entity view again, so pinning is offered.
    expect(screen.getByRole("button", { name: "Pin panel" })).toBeInTheDocument();

    panelState = null;
    rerender(<PanelShell initialPin={unpinned} />);
    panelState = { type: "feedback", id: "fb-2" };
    rerender(<PanelShell initialPin={unpinned} />);
    // A fresh session for an unpinned user is the usual overlay again.
    expect(aside()).toBeNull();
  });

  it("resizing the docked composer does not pin the user's future panels", () => {
    render(<PanelShell initialPin={unpinned} />);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize panel" }), { key: "ArrowLeft" });
    expect(readPinCookie()).toMatch(/^0:\d+$/);
  });

  it("does not close when Escape comes from a dialog portalled out of the composer", () => {
    render(<PanelShell initialPin={unpinned} />);
    fireEvent.keyDown(screen.getByTestId("portalled"), { key: "Escape" });
    expect(closePanel).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
    expect(closePanel).toHaveBeenCalledTimes(1);
  });
});

describe("PanelShell — opportunity composer", () => {
  beforeEach(() => {
    panelState = { type: "opportunity-new", id: "new-validating" };
  });

  it("docks like the feedback composer, titled New opportunity, and passes the column preset through", () => {
    render(<PanelShell initialPin={unpinned} />);
    expect(aside()).not.toBeNull();
    expect(screen.getByRole("heading", { name: "New opportunity" })).toBeInTheDocument();
    expect(screen.getByTestId("opportunity-composer-body")).toHaveTextContent("new-validating");
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pin panel|Unpin panel/ })).toBeNull();
  });

  it("falls back to a full-width sheet below the pin breakpoint", async () => {
    setViewportAllowsPin(false);
    render(<PanelShell initialPin={unpinned} />);
    const body = await screen.findByTestId("opportunity-composer-body", {}, { timeout: 2000 });
    expect(body.closest('[data-slot="sheet-content"]')).toHaveClass("w-full", "sm:max-w-xl");
  });

  it("keeps the created opportunity docked after the hand-off", () => {
    const { rerender } = render(<PanelShell initialPin={unpinned} />);
    panelState = { type: "opportunity", id: "opp-1" };
    rerender(<PanelShell initialPin={unpinned} />);
    expect(aside()).not.toBeNull();
    expect(screen.getByTestId("opportunity-body")).toHaveTextContent("opp-1");
  });
});
