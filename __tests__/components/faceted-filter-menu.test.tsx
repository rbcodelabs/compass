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

  it("renders a multi-select group as checked checkbox items and toggles one value", async () => {
    const onValuesChange = vi.fn();
    render(
      <FacetedFilterMenu
        groups={[
          {
            id: "status",
            label: "Status",
            values: ["OPEN", "UNDER_REVIEW", "PLANNED"],
            options: [
              { value: "OPEN", label: "Open" },
              { value: "UNDER_REVIEW", label: "Under review" },
              { value: "PLANNED", label: "Planned" },
            ],
            onValuesChange,
          },
        ]}
        onClearAll={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    const open = await screen.findByRole("menuitemcheckbox", { name: "Open" });
    expect(open.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Under review" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Planned" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(open);
    expect(onValuesChange).toHaveBeenCalledWith(["UNDER_REVIEW", "PLANNED"]);
  });
});
