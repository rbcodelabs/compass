// @vitest-environment jsdom

import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { push, searchParams } = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core/discovery",
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams.current,
}));

import { ExperimentsFilters } from "@/components/experiments/experiments-filters";
import { DiscoveryFilters } from "@/components/discovery/discovery-filters";
import type { SquadData } from "@/lib/types";

afterEach(cleanup);

const squads: SquadData[] = [{ id: "sq1", name: "Squad One", color: "#112233" }];

const CASES = [
  { name: "Experiments", Component: ExperimentsFilters },
  { name: "Discovery", Component: DiscoveryFilters },
] as const;

describe.each(CASES)("$name faceted filters", ({ Component }) => {
  beforeEach(() => {
    push.mockClear();
    searchParams.current = new URLSearchParams();
  });

  function openMenu(query = "") {
    searchParams.current = new URLSearchParams(query);
    render(h(Component, { squads }));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  }

  it("adapts squads to the shared filter menu", async () => {
    openMenu();

    // The squad facet is offered with its real name and color, and
    // selecting it writes the squad id onto the URL.
    const option = await screen.findByRole("menuitemradio", { name: "Squad One" });
    const swatch = option.querySelector("span[style]");
    expect(swatch).toHaveStyle({ backgroundColor: "#112233" });

    fireEvent.click(option);
    expect(push).toHaveBeenCalledWith("/acme/core/discovery?squad=sq1");
  });

  it("clears squad atomically while preserving unrelated query parameters", async () => {
    openMenu("squad=sq1&assumptionId=abc123");

    const clearAll = await screen.findByRole("menuitem", { name: "Clear all" });
    fireEvent.click(clearAll);

    // Exactly one navigation, squad gone, the unrelated param untouched.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/acme/core/discovery?assumptionId=abc123");
  });
});
