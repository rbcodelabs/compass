import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: () => null }));

import { PanelShell } from "@/components/panels/panel-shell";

describe("PanelShell hydration", () => {
  it("keeps an initial deep-linked sheet closed in server HTML", () => {
    const html = renderToString(<PanelShell />);

    expect(html).toContain('data-testid="sheet-root"');
    expect(html).toContain('data-open="false"');
  });
});
