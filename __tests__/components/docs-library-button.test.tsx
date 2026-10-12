// @vitest-environment jsdom

/**
 * The Docs header's Library button: opens the agent rail on its Library view,
 * toggles it closed when the Library is already showing, and renders nothing
 * where there is no rail to open.
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

let pathname = "/acme/product/docs";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import { AgentRailProvider, useAgentRail } from "@/components/agent/agent-rail-context";
import { DocsLibraryButton } from "@/components/docs/docs-library-button";

/** Surfaces the rail state the button is supposed to drive. */
function RailState() {
  const { open, view } = useAgentRail();
  return <output data-testid="rail-state">{`${open ? "open" : "closed"}:${view}`}</output>;
}

function renderWithRail(pinned = false) {
  return render(
    <AgentRailProvider initialPin={{ pinned, width: 448 }}>
      <DocsLibraryButton />
      <RailState />
    </AgentRailProvider>,
  );
}

beforeEach(() => {
  pathname = "/acme/product/docs";
});

afterEach(() => {
  cleanup();
  document.cookie = "compass_panel_agent=; Path=/; Max-Age=0";
});

describe("DocsLibraryButton", () => {
  it("renders nothing outside an AgentRailProvider", () => {
    const { container } = render(<DocsLibraryButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on the full-page agent screen, where the rail is unavailable", () => {
    pathname = "/acme/product/agent";
    renderWithRail();
    expect(screen.queryByRole("button", { name: /library/i })).toBeNull();
  });

  it("opens the closed rail on the Library view", () => {
    renderWithRail(false);
    expect(screen.getByTestId("rail-state")).toHaveTextContent("closed:agent");

    fireEvent.click(screen.getByRole("button", { name: "Show library" }));

    expect(screen.getByTestId("rail-state")).toHaveTextContent("open:library");
    expect(document.cookie).toContain("compass_panel_agent=");
  });

  it("switches an already-open rail from another view to Library", () => {
    renderWithRail(true);
    expect(screen.getByTestId("rail-state")).toHaveTextContent("open:agent");

    fireEvent.click(screen.getByRole("button", { name: "Show library" }));

    expect(screen.getByTestId("rail-state")).toHaveTextContent("open:library");
  });

  it("closes the rail when pressed while the Library is showing", () => {
    renderWithRail(false);
    fireEvent.click(screen.getByRole("button", { name: "Show library" }));

    const hide = screen.getByRole("button", { name: "Hide library" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(hide);

    expect(screen.getByTestId("rail-state")).toHaveTextContent("closed:library");
    expect(screen.getByRole("button", { name: "Show library" })).toHaveAttribute("aria-pressed", "false");
  });
});
