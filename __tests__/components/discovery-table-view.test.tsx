// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DiscoveryTableView, type DiscoveryTableOpportunity } from "@/components/discovery/discovery-table-view";

const openPanel = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

const opportunities: DiscoveryTableOpportunity[] = [
  {
    id: "opp-1",
    title: "Understand onboarding friction",
    customerSegment: "New teams",
    status: "EXPLORING",
    sortOrder: 0,
    squad: { id: "squad-1", name: "Growth", color: "#ff6600" },
    evidenceCount: 4,
    solutions: [
      { id: "sol-1", title: "Guided setup", status: "IDEA", sortOrder: 0, evidenceCount: 2, assumptionCount: 3 },
      { id: "sol-2", title: "Retired wizard", status: "KILLED", sortOrder: 1, evidenceCount: 0, assumptionCount: 1 },
    ],
  },
  {
    id: "opp-2",
    title: "Improve reporting",
    customerSegment: null,
    status: "ACTIVE",
    sortOrder: 0,
    squad: null,
    evidenceCount: 0,
    solutions: [],
  },
];

describe("DiscoveryTableView", () => {
  afterEach(() => {
    cleanup();
    openPanel.mockReset();
  });

  it("starts collapsed and expands all child solutions, including killed solutions", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const expand = screen.getByRole("button", { name: "Expand Understand onboarding friction" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Guided setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Retired wizard")).not.toBeInTheDocument();

    fireEvent.click(expand);

    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Guided setup")).toBeInTheDocument();
    expect(screen.getByText("Retired wizard")).toBeInTheDocument();
    expect(screen.getByText("Killed")).toBeInTheDocument();
    expect(screen.getByText("3 assumptions")).toBeInTheDocument();
  });

  it("does not offer expansion for an opportunity without solutions", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const row = screen.getByText("Improve reporting").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).queryByRole("button", { name: /Expand/ })).not.toBeInTheDocument();
    expect(within(row!).getByText("0 solutions")).toBeInTheDocument();
  });

  it("opens the existing opportunity and solution panels from title buttons", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    fireEvent.click(screen.getByRole("button", { name: "Understand onboarding friction" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Understand onboarding friction" }));
    fireEvent.click(screen.getByRole("button", { name: "Guided setup" }));

    expect(openPanel).toHaveBeenNthCalledWith(1, "opportunity", "opp-1");
    expect(openPanel).toHaveBeenNthCalledWith(2, "solution", "sol-1");
  });

  // Regression: the wrapper around the table used a bare, unbounded div, so
  // inside WorkspacePage's `md:overflow-hidden` content area it inherited
  // clipping instead of scrolling — rows and the table's own horizontal
  // scrollbar past the fold were unreachable ("the table doesn't scroll"
  // bug). The wrapper must be the scroll viewport itself: bounded height
  // (`min-h-0 flex-1`) and `overflow-y-auto`, never a bare `overflow-hidden`.
  it("makes its own wrapper the scroll viewport instead of clipping overflow", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const scrollContainer = screen.getByTestId("discovery-table-scroll");
    expect(scrollContainer.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(scrollContainer.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });
});
