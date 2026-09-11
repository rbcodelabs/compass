// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DecisionsTabs } from "@/components/decisions/decisions-tabs";
import { DecisionsFilters } from "@/components/decisions/decisions-filters";

const set = vi.fn();
let params = new URLSearchParams();

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ set, params }),
}));

const REVIEWERS = [{ id: "11111111-1111-4111-8111-111111111111", name: "Ada Lovelace" }];

beforeEach(() => {
  params = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  set.mockReset();
});

describe("DecisionsTabs", () => {
  it("represents Decided in the URL and Pending by the absence of the tab parameter", () => {
    const { rerender } = render(<DecisionsTabs tab="PENDING" />);
    fireEvent.click(screen.getByRole("tab", { name: "Decided" }));
    expect(set).toHaveBeenCalledWith({ tab: "decided", page: null });

    rerender(<DecisionsTabs tab="DECIDED" />);
    fireEvent.click(screen.getByRole("tab", { name: "Pending" }));
    expect(set).toHaveBeenLastCalledWith({ tab: null, page: null });
  });

  it("reflects the active tab so the control is never ambiguous", () => {
    render(<DecisionsTabs tab="DECIDED" />);
    expect(screen.getByRole("tab", { name: "Decided" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Pending" })).toHaveAttribute("aria-selected", "false");
  });
});

describe("DecisionsFilters", () => {
  it("collapses search behind a trigger instead of rendering a wide inline input", () => {
    // The regression this guards: a `sm:w-64` input placed directly in
    // WorkspacePage's non-wrapping `actions` row squeezed the "Decisions"
    // <h1> to zero width at 390px. Search must stay behind a trigger.
    render(<DecisionsFilters reviewers={REVIEWERS} />);
    expect(screen.getByRole("button", { name: "Search decisions" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search decisions" })).toBeNull();
  });

  it("debounces typed search into the URL and resets pagination", async () => {
    vi.useFakeTimers();
    try {
      render(<DecisionsFilters reviewers={REVIEWERS} />);
      fireEvent.click(screen.getByRole("button", { name: "Search decisions" }));
      const input = await vi.waitFor(() => screen.getByRole("searchbox", { name: "Search decisions" }));

      fireEvent.change(input, { target: { value: "checkout" } });
      expect(set).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(set).toHaveBeenCalledWith({ q: "checkout", page: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an active search back out of the URL entirely", async () => {
    params = new URLSearchParams("q=checkout");
    vi.useFakeTimers();
    try {
      render(<DecisionsFilters reviewers={REVIEWERS} />);
      fireEvent.click(screen.getByRole("button", { name: "Search decisions" }));
      const clear = await vi.waitFor(() => screen.getByRole("button", { name: "Clear search" }));

      fireEvent.click(clear);
      vi.advanceTimersByTime(300);
      // `null`, not "", so the cleared filter leaves no trace in the URL.
      expect(set).toHaveBeenCalledWith({ q: null, page: null });
    } finally {
      vi.useRealTimers();
    }
  });

  // Each facet gets its own render: selecting an option closes the menu, so
  // driving all three from one mounted component would only exercise the first.
  it.each([
    ["Solution", { type: "SOLUTION", page: null }],
    ["Changes requested", { outcome: "REQUEST_CHANGES", page: null }],
    ["Ada Lovelace", { reviewer: REVIEWERS[0].id, page: null }],
  ] as const)("writes the %s facet to its own URL parameter and resets pagination", async (option, expected) => {
    render(<DecisionsFilters reviewers={REVIEWERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await waitFor(() => screen.getByRole("menuitemradio", { name: option })));
    expect(set).toHaveBeenCalledWith(expected);
  });

  it("surfaces an active-filter count and clears every facet at once", async () => {
    params = new URLSearchParams("type=SOLUTION&outcome=APPROVE");
    render(<DecisionsFilters reviewers={REVIEWERS} />);
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Clear all" })));
    expect(set).toHaveBeenCalledWith({ type: null, outcome: null, reviewer: null, page: null });
  });

  it("applies a date range only on submit, and clears both bounds together", async () => {
    render(<DecisionsFilters reviewers={REVIEWERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by date" }));

    const from = await waitFor(() => screen.getByLabelText("From"));
    fireEvent.change(from, { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
    // Typing a bound must not navigate — a half-entered range would filter
    // the list out from under the user mid-edit.
    expect(set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(set).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-30", page: null });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(set).toHaveBeenLastCalledWith({ from: null, to: null, page: null });
  });
});
