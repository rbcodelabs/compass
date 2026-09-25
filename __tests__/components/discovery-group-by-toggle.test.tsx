// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DiscoveryGroupByToggle } from "@/components/discovery/discovery-group-by-toggle";

const set = vi.fn();

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ set }),
}));

/**
 * Base UI's SelectItem only commits a mouse click when a `pointerdown` primed
 * it first — same recipe as __tests__/components/roadmap-group-by-toggle.test.tsx.
 */
function choose(name: string) {
  fireEvent.click(screen.getByLabelText("Group board by"));
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

describe("DiscoveryGroupByToggle", () => {
  afterEach(() => {
    cleanup();
    set.mockReset();
  });

  it("represents Opportunity in the URL and Status by the absence of the groupBy parameter", () => {
    const { rerender } = render(<DiscoveryGroupByToggle groupBy="status" />);
    choose("Opportunity");
    expect(set).toHaveBeenCalledWith({ groupBy: "opportunity" });

    rerender(<DiscoveryGroupByToggle groupBy="opportunity" />);
    choose("Status");
    expect(set).toHaveBeenLastCalledWith({ groupBy: null });
  });

  it("offers each groupable Opportunity field after the built-ins and encodes it as field:<id>", () => {
    render(<DiscoveryGroupByToggle groupBy="status" fieldOptions={[{ id: "moscow", label: "MoSCoW" }]} />);
    fireEvent.click(screen.getByLabelText("Group board by"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Status", "Opportunity", "MoSCoW"]);

    const option = screen.getByRole("option", { name: "MoSCoW" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    expect(set).toHaveBeenCalledWith({ groupBy: "field:moscow" });
  });

  it("shows the active field grouping by its field name", () => {
    render(<DiscoveryGroupByToggle groupBy="field:moscow" fieldOptions={[{ id: "moscow", label: "MoSCoW" }]} />);
    expect(screen.getByLabelText("Group board by")).toHaveTextContent("Group by:MoSCoW");
  });
});
