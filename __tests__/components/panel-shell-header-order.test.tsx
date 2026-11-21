// @vitest-environment jsdom

/**
 * The real PanelShell with a stub panel that declares every header action: the shell, not the panel, decides the
 * order, so every panel gets Follow, Request decision, Open full page, then the shell's own Pin and Close.
 * (panel-header-actions.test.tsx covers the hook against a stand-in shell; this pins the real wiring.)
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PANEL_WIDTH_DEFAULT } from "@/lib/panel-pin";
import { usePanelHeaderActions } from "@/components/panels/panel-header-actions";

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    panel: { type: "solution", id: "sol-1" },
    closePanel: vi.fn(),
    openPanel: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
    notifyEntityMutated: vi.fn(),
    subscribeEntityMutated: () => () => undefined,
    setDetailPanelDock: vi.fn(),
  }),
}));

vi.mock("@/components/panels/solution-panel", () => ({
  SolutionPanel: () => {
    usePanelHeaderActions({
      fullPageHref: "/acme/product/solutions/sol-1",
      follow: { subjectType: "SOLUTION", subjectId: "sol-1" },
      decision: { subjectType: "SOLUTION", subjectId: "sol-1", subjectTitle: "Ship it" },
    });
    return <div>Solution body</div>;
  },
}));
vi.mock("@/components/panels/objective-panel", () => ({ ObjectivePanel: () => null }));
vi.mock("@/components/panels/key-result-panel", () => ({ KeyResultPanel: () => null }));
vi.mock("@/components/panels/opportunity-panel", () => ({ OpportunityPanel: () => null }));
vi.mock("@/components/panels/assumption-panel", () => ({ AssumptionPanel: () => null }));
vi.mock("@/components/panels/experiment-panel", () => ({ ExperimentPanel: () => null }));
vi.mock("@/components/panels/roadmap-item-panel", () => ({ RoadmapItemPanel: () => null }));
vi.mock("@/components/panels/decision-panel", () => ({ DecisionPanel: () => null }));
vi.mock("@/components/panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("@/components/panels/discovery-rail-panel", () => ({ DiscoveryRailPanel: () => null }));
vi.mock("@/components/panels/pull-request-panel", () => ({ PullRequestPanel: () => null }));
vi.mock("@/components/feedback/feedback-composer", () => ({ FeedbackComposer: () => null }));
vi.mock("@/components/discovery/opportunity-composer", () => ({ OpportunityComposer: () => null }));
vi.mock("@/components/experiments/experiment-composer", () => ({ ExperimentComposer: () => null }));
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: () => null }));

import { PanelShell } from "@/components/panels/panel-shell";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ available: true, following: false }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PanelShell header order", () => {
  it("renders Follow, Request decision, Open full page, Pin, Close in that order, in one row", async () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    const fullPage = await screen.findByRole("link", { name: "Open full page" });
    const row = fullPage.parentElement as HTMLElement;
    const follow = await screen.findByRole("button", { name: "Follow" });
    const names = Array.from(row.querySelectorAll("a, button")).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Follow", "Request decision", "Open full page", "Unpin panel", "Close panel"]);
    expect(row).toContainElement(follow);
  });
});
