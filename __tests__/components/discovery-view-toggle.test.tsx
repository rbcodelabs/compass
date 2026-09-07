// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DiscoveryViewToggle } from "@/components/discovery/discovery-view-toggle";

const set = vi.fn();

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ set }),
}));

describe("DiscoveryViewToggle", () => {
  afterEach(() => {
    cleanup();
    set.mockReset();
  });

  it("represents Table in the URL and Board by the absence of the view parameter", () => {
    const { rerender } = render(<DiscoveryViewToggle view="board" />);
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(set).toHaveBeenCalledWith({ view: "table" });

    rerender(<DiscoveryViewToggle view="table" />);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(set).toHaveBeenLastCalledWith({ view: null });
  });
});
