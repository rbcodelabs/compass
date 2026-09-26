// @vitest-environment jsdom
import React from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    panel: { type: "objective", id: "objective-1" },
    closePanel: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
  }),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-testid="sheet-root" data-open={String(open)}>{children}</div>
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/panels/experiment-panel", () => ({ ExperimentPanel: () => null }));
vi.mock("@/components/panels/opportunity-panel", () => ({ OpportunityPanel: () => null }));
vi.mock("@/components/panels/discovery-rail-panel", () => ({ DiscoveryRailPanel: () => null }));
vi.mock("@/components/panels/objective-panel", () => ({ ObjectivePanel: () => null }));
vi.mock("@/components/panels/key-result-panel", () => ({ KeyResultPanel: () => null }));
vi.mock("@/components/panels/solution-panel", () => ({ SolutionPanel: () => null }));
vi.mock("@/components/panels/assumption-panel", () => ({ AssumptionPanel: () => null }));
vi.mock("@/components/panels/roadmap-item-panel", () => ({ RoadmapItemPanel: () => null }));
vi.mock("@/components/panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("@/components/feedback/feedback-composer", () => ({ FeedbackComposer: () => null }));
vi.mock("@/components/discovery/opportunity-composer", () => ({ OpportunityComposer: () => null }));
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: () => null }));

import { PanelShell } from "@/components/panels/panel-shell";

function sheetOpenState(): string | null {
  return screen.getByTestId("sheet-root").getAttribute("data-open");
}

/** Put the document past the `load` boundary the panel waits for. */
function settleLoad() {
  act(() => {
    window.dispatchEvent(new Event("load"));
  });
}

describe("PanelShell hydration", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps an initial deep-linked sheet closed in server HTML", () => {
    const html = renderToString(<PanelShell />);

    expect(html).toContain('data-testid="sheet-root"');
    expect(html).toContain('data-open="false"');
  });

  /**
   * Browsers throttle or indefinitely defer requestIdleCallback in a
   * backgrounded tab, and do not reliably honor its `timeout` there either.
   * The deep-link open path must not be the only thing standing between a user
   * and a panel: a `?detail=…` link opened in a background tab used to render
   * no panel at all. Found during production verification of PR #230.
   */
  it("opens a deep-linked panel when requestIdleCallback never fires", () => {
    vi.useFakeTimers();
    const neverFires = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", neverFires);
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    render(<PanelShell />);
    settleLoad();

    // The first client render must still match the server HTML above.
    expect(sheetOpenState()).toBe("false");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(neverFires).toHaveBeenCalled();
    expect(sheetOpenState()).toBe("true");
  });

  it("opens a deep-linked panel in a browser with no requestIdleCallback", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    // The previous fallback was requestAnimationFrame, which is throttled in a
    // background tab exactly like requestIdleCallback.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));

    render(<PanelShell />);
    settleLoad();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(sheetOpenState()).toBe("true");
  });

  it("still opens once, and stays open, when the idle callback also runs", () => {
    vi.useFakeTimers();
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idleCallbacks.push(cb);
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    render(<PanelShell />);
    settleLoad();

    act(() => {
      idleCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(5_000);
    });

    expect(sheetOpenState()).toBe("true");
  });
});
