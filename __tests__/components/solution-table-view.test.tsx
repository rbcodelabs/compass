// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SolutionTableView } from "@/components/solutions/solution-table-view";
import type { SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";

const openPanel = vi.fn();
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

afterEach(() => {
  cleanup();
  openPanel.mockClear();
});

function item(id: string, title: string, over: Partial<SolutionBacklogItem> = {}): SolutionBacklogItem {
  return {
    id,
    title,
    description: null,
    status: "IDEA",
    sortOrder: 0,
    _count: { assumptions: 2, evidence: 3 },
    score: null,
    opportunity: { id: `opp-${id}`, title: `Parent of ${title}`, squad: { id: "sq", name: "Alpha", color: "#111111" } },
    ...over,
  };
}

const render_ = (props: Partial<React.ComponentProps<typeof SolutionTableView>> = {}) =>
  render(
    <SolutionTableView
      solutions={[item("s1", "Wizard"), item("s2", "Checklist", { status: "SHIPPED", score: { normalizedScore: 72, modelVersion: 1, liveModelVersion: 1, stale: false } })]}
      orgSlug="org"
      workspaceSlug="ws"
      {...props}
    />
  );

describe("SolutionTableView", () => {
  it("renders one row per solution with parent, squad, status and counts", () => {
    render_();
    const table = screen.getByRole("table", { name: "Solution backlog" });
    const wizardRow = within(table).getByText("Wizard").closest("tr") as HTMLElement;
    expect(within(wizardRow).getByRole("link", { name: "Parent of Wizard" })).toHaveAttribute("href", "/org/ws/discovery/opp-s1");
    expect(within(wizardRow).getByText("Alpha")).toBeInTheDocument();
    expect(within(wizardRow).getByText("Idea")).toBeInTheDocument();
    expect(within(wizardRow).getByText("Backed by 3 signals")).toBeInTheDocument();
    expect(within(wizardRow).getByText("2 assumptions")).toBeInTheDocument();
  });

  it("opens the solution panel from the title", () => {
    render_();
    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(openPanel).toHaveBeenCalledWith("solution", "s2");
  });

  it("renders rows in the order given (the page owns filtering and sorting)", () => {
    render_({ solutions: [item("b", "Second"), item("a", "First")] });
    const titles = screen.getAllByRole("button", { name: /^(First|Second)$/ }).map((b) => b.textContent);
    expect(titles).toEqual(["Second", "First"]);
  });

  it("shows a Score column only when a Solution scoring model is active", () => {
    const { unmount } = render_();
    expect(screen.queryByRole("columnheader", { name: /Score/ })).not.toBeInTheDocument();
    unmount();
    render_({ hasActiveScoringModel: true });
    expect(screen.getByRole("columnheader", { name: /Score/ })).toBeInTheDocument();
    expect(screen.getByText("Score 72")).toBeInTheDocument();
    expect(screen.getByText("Not scored")).toBeInTheDocument();
  });

  it("shows an empty message when no solution matches", () => {
    render_({ solutions: [] });
    expect(screen.getByText("No solutions match the current filters.")).toBeInTheDocument();
  });
});
