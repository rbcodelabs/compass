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

  it("represents Status by the absence of the groupBy parameter", () => {
    render(<DiscoveryGroupByToggle groupBy="field:moscow" fieldOptions={[{ id: "moscow", label: "MoSCoW" }]} />);
    choose("Status");
    expect(set).toHaveBeenLastCalledWith({ groupBy: null });
  });

  it("no longer offers an Opportunity (solution swimlane) grouping", () => {
    render(<DiscoveryGroupByToggle groupBy="status" />);
    fireEvent.click(screen.getByLabelText("Group board by"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Status"]);
  });

  it("offers each groupable Opportunity field after the built-ins and encodes it as field:<id>", () => {
    render(<DiscoveryGroupByToggle groupBy="status" fieldOptions={[{ id: "moscow", label: "MoSCoW" }]} />);
    fireEvent.click(screen.getByLabelText("Group board by"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Status", "MoSCoW"]);

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
