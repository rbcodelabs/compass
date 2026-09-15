// @vitest-environment jsdom
/**
 * Regression cover for the Feedback grid's vertical sizing.
 *
 * `FeedbackGrid` renders straight into `WorkspacePage`'s content area, which is
 * `md:overflow-hidden`. A DataGrid left at the default `height="natural"` grows
 * to fit its rows there, and the surrounding content area *clips* the overflow
 * rather than scrolling it — so with a full page of rows the last rows and the
 * pagination footer were painted below the fold with no way to reach them.
 * Measured in a real browser at 1280x800 with 20 rows: zero user-scrollable
 * ancestors between the grid and `<html>`, the last row's bottom at 1209px and
 * the pagination footer's at 1262px, and twelve wheel gestures plus the End key
 * moved none of it. The defect predates the DataGrid standardization work — it
 * reproduced identically on `origin/main`.
 *
 * The fix is `height="fill"`, the same prop Discovery and Tasks already pass:
 * the grid stops growing, claims the height its parent offers, and its own
 * `table-container` becomes the scroll viewport (which is also where a sticky
 * `<th>` resolves — a wrapper outside it would scroll the header away).
 *
 * These assertions mirror the equivalent ones in `discovery-table-view.test.tsx`
 * and `task-list-view.test.tsx` so all three consumers are held to one contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const openPanel = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
const setAll = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(), setAll }),
}));

// Server actions cannot execute under vitest; the grid only needs them to be
// callable references at render time.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/feedback/actions", () => ({
  updateFeedbackStatus: vi.fn(),
  updateFeedbackType: vi.fn(),
  linkFeedbackToOpportunity: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  promoteFeedbackToRoadmap: vi.fn(),
}));

import { FeedbackGrid } from "@/components/feedback/feedback-grid";
import type { FeedbackRow } from "@/components/feedback/feedback-columns";
import { DEFAULT_FEEDBACK_QUERY } from "@/lib/feedback-query";

const items: FeedbackRow[] = [
  {
    id: "fb-1",
    title: "Export takes too long",
    description: "The CSV export spins for minutes.",
    submitterName: "Ada",
    submitterEmail: "ada@example.com",
    status: "OPEN",
    voteCount: 12,
    type: "BUG",
    opportunityId: null,
    roadmapItem: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    attachments: [],
  },
  {
    id: "fb-2",
    title: "Dark mode for the portal",
    description: "Customers keep asking.",
    submitterName: "Grace",
    submitterEmail: "grace@example.com",
    status: "UNDER_REVIEW",
    voteCount: 5,
    type: "IDEA",
    opportunityId: null,
    roadmapItem: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    attachments: [],
  },
];

function renderGrid() {
  return render(
    <FeedbackGrid
      orgSlug="acme"
      workspaceSlug="product"
      workspaceId="ws-1"
      items={items}
      opportunities={[{ id: "opp-1", title: "Faster exports" }]}
      total={items.length}
      query={DEFAULT_FEEDBACK_QUERY}
      hasAnyFeedback
    />,
  );
}

describe("FeedbackGrid", () => {
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
    push.mockReset();
    refresh.mockReset();
    setAll.mockReset();
  });

  // The defect itself. Without `height="fill"` the root renders
  // `data-height="natural"` and drops `min-h-0 flex-1`, so it grows past the
  // clipped content area instead of fitting inside it.
  it("renders the grid in fill mode so it fits the clipped content area", () => {
    renderGrid();

    const root = screen.getByTestId("data-grid");
    expect(root).toHaveAttribute("data-height", "fill");
    expect(root.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(root.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });

  // The other half: claiming the height is only useful if something inside it
  // actually scrolls. The viewport must be the grid's own `table-container`.
  it("makes the grid's own table-container the scroll viewport", () => {
    const { container } = renderGrid();

    const scrollContainer = container.querySelector('[data-slot="table-container"]');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(scrollContainer!.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });

  // Rows scrolling under the header are only readable if the header stays put.
  it("sticks the header row to the top of the viewport", () => {
    renderGrid();

    const heads = screen.getAllByRole("columnheader");
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head.className).toMatch(/(?:^|\s)sticky(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)top-0(?:\s|$)/);
    }
  });

  // Fill mode changes sizing only. These guard the surface the fix sits next to
  // — Feedback is the original DataGrid consumer and carries the most behaviour.
  it("keeps its columns, rows and pagination footer intact in fill mode", () => {
    renderGrid();

    // By role rather than by `[data-testid^='grid-head-']` — each header also
    // contains a nested `grid-head-label`, so that prefix selector returns two
    // nodes per column.
    expect(screen.getAllByRole("columnheader").map((node) => node.textContent?.trim())).toEqual([
      "Feedback",
      "Type",
      "Votes",
      "Status",
      "Submitted",
      "Action",
    ]);

    const rows = screen.getAllByTestId("grid-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Export takes too long")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Dark mode for the portal")).toBeInTheDocument();

    // The pagination footer is the element the defect put furthest out of
    // reach, so its presence inside the filled grid is the payoff.
    const pagination = screen.getByTestId("grid-pagination");
    expect(pagination).toBeInTheDocument();
    expect(screen.getByTestId("data-grid")).toContainElement(pagination);
  });

  // The editable cells are the optimistic-overlay path. Fill mode must not
  // disturb the controls the overlay writes through.
  it("keeps the inline status and type editors rendered", () => {
    renderGrid();

    const row = screen.getAllByTestId("grid-row")[0];

    const typeCell = within(row).getByTestId("grid-cell-type");
    expect(typeCell).toHaveTextContent("Bug");
    expect(within(typeCell).getByRole("combobox")).toBeInTheDocument();

    const statusCell = within(row).getByTestId("grid-cell-status");
    expect(statusCell).toHaveTextContent("Open");
    expect(within(statusCell).getByRole("combobox")).toBeInTheDocument();
  });
});
