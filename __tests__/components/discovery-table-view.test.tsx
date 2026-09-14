// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DiscoveryTableView, type DiscoveryTableOpportunity } from "@/components/discovery/discovery-table-view";
import { expectEveryGridCellClipped } from "../helpers/grid-cells";

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
  // The grid reads `matchMedia` through `useIsMobile`; jsdom does not ship one.
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

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

  it("renders one row per visible opportunity, plus its solutions once expanded", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const titles = () =>
      screen
        .getAllByTestId("grid-row")
        .map((row) => row.querySelector('[data-col="item"] button:last-of-type')?.textContent);

    expect(titles()).toEqual(["Understand onboarding friction", "Improve reporting"]);

    fireEvent.click(screen.getByRole("button", { name: "Expand Understand onboarding friction" }));

    // Children are spliced in directly after their parent, not appended.
    expect(titles()).toEqual([
      "Understand onboarding friction",
      "Guided setup",
      "Retired wizard",
      "Improve reporting",
    ]);

    // A solution row is visually distinguished from its parent.
    const solutionRow = screen.getByText("Guided setup").closest("tr");
    expect(solutionRow?.className).toMatch(/bg-surface-inset/);
  });

  // `table.FlexRender` unmounts and remounts a cell's entire subtree whenever
  // the column definition's identity changes. Expansion state therefore has to
  // ride on the row data, not on a closure captured by the column — otherwise
  // toggling a row destroys and recreates the very button the user activated,
  // and keyboard focus jumps to the document body mid-interaction.
  it("keeps focus on the disclosure button across a toggle", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const expand = screen.getByRole("button", { name: "Expand Understand onboarding friction" });
    expand.focus();
    expect(document.activeElement).toBe(expand);

    fireEvent.click(expand);

    // Same DOM node, updated in place — not a replacement.
    expect(screen.getByRole("button", { name: "Collapse Understand onboarding friction" })).toBe(expand);
    expect(document.activeElement).toBe(expand);
  });

  it("gives the table an accessible name via its caption", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);
    // e2e/functional/specs/discovery-table.spec.ts locates the table by this
    // exact name. A <caption> is the accname for role=table.
    expect(screen.getByRole("table", { name: "Discovery opportunities" })).toBeInTheDocument();
  });

  // Regression: the wrapper around the table used a bare, unbounded div, so
  // inside WorkspacePage's `md:overflow-hidden` content area it inherited
  // clipping instead of scrolling — rows and the table's own horizontal
  // scrollbar past the fold were unreachable ("the table doesn't scroll"
  // bug). This view must own a real scroll viewport: bounded height
  // (`min-h-0 flex-1`) and `overflow-y-auto`, never a bare `overflow-hidden`.
  //
  // The viewport has since moved OFF the page-level wrapper this view used to
  // render and ONTO the grid's own `table-container`, because that div is
  // already a scroll container (`overflow-x: auto` computes `overflow-y` to
  // `auto`) and is therefore where a sticky `<th>` resolves. A wrapper outside
  // it would scroll the header away with the rows.
  it("makes the grid's own table-container the scroll viewport", () => {
    const { container } = render(<DiscoveryTableView opportunities={opportunities} />);

    const scrollContainer = container.querySelector('[data-slot="table-container"]');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    // The horizontal axis is untouched — the mobile E2E asserts it directly.
    expect(scrollContainer!.className).toMatch(/(?:^|\s)overflow-x-auto(?:\s|$)/);
  });

  // The other half of the same invariant: rows scrolling past the header are
  // only useful if the header stays put and stays opaque.
  it("sticks the header row to the top of the viewport", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);

    const heads = screen.getAllByRole("columnheader");
    expect(heads).toHaveLength(6);
    for (const head of heads) {
      expect(head.className).toMatch(/(?:^|\s)sticky(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)top-0(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)bg-surface-panel(?:\s|$)/);
    }
  });

  // Same class of defect as the Tasks Assignee regression: Customer segment is
  // a 10rem hard box rendering a bare server string with nothing to clip it.
  it("clips an over-long customer segment instead of painting it over Evidence", () => {
    const { container } = render(
      <DiscoveryTableView
        opportunities={[
          {
            ...opportunities[0],
            customerSegment: "Enterprise platform teams in regulated industries",
          },
        ]}
      />,
    );

    const segment = within(container).getAllByTestId("grid-cell-segment")[0];
    expect(segment).toHaveTextContent("Enterprise platform teams in regulated industries");
    expect(segment.className).toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);

    expectEveryGridCellClipped(container);
  });
});
