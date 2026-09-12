// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DiscoveryGroupByToggle } from "@/components/discovery/discovery-group-by-toggle";

const set = vi.fn();

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ set }),
}));

describe("DiscoveryGroupByToggle", () => {
  afterEach(() => {
    cleanup();
    set.mockReset();
  });

  it("represents Opportunity in the URL and Status by the absence of the groupBy parameter", () => {
    const { rerender } = render(<DiscoveryGroupByToggle groupBy="status" />);
    fireEvent.click(screen.getByRole("tab", { name: "Opportunity" }));
    expect(set).toHaveBeenCalledWith({ groupBy: "opportunity" });

    rerender(<DiscoveryGroupByToggle groupBy="opportunity" />);
    fireEvent.click(screen.getByRole("tab", { name: "Status" }));
    expect(set).toHaveBeenLastCalledWith({ groupBy: null });
  });
});
