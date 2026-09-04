// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacetedFilterMenu } from "@/components/patterns/faceted-filter-menu";

afterEach(cleanup);

describe("FacetedFilterMenu", () => {
  it("opens a labeled filter group without crashing", async () => {
    render(
      <FacetedFilterMenu
        groups={[
          {
            id: "squad",
            label: "Squad",
            value: null,
            options: [{ value: "growth", label: "Growth" }],
            onValueChange: vi.fn(),
          },
        ]}
        onClearAll={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect(await screen.findByText("Squad")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Growth" })).toBeTruthy();
  });

  it("renders an explicit all choice that clears only its group", async () => {
    const onValueChange = vi.fn();
    render(
      <FacetedFilterMenu
        groups={[{
          id: "type",
          label: "Type",
          value: "BUG",
          allLabel: "All",
          options: [{ value: "BUG", label: "Bugs" }],
          onValueChange,
        }]}
        onClearAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "All" }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });
});
