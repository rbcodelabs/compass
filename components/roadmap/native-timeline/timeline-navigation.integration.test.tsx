// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  usePathname: () => "/org/workspace/roadmap",
  useSearchParams: () => navigation.params,
}));

import { PanelProvider } from "@/components/panels/panel-context";
import { useTimelinePanelNavigation } from "./timeline-shared";

function VirtualizedHarness() {
  const { openItem, triggerItemId } = useTimelinePanelNavigation();
  return triggerItemId === null || triggerItemId === "item-42"
    ? <button data-timeline-item-id="item-42" onClick={() => openItem("item-42")}>Open item</button>
    : null;
}

afterEach(() => { cleanup(); navigation.params = new URLSearchParams(); vi.clearAllMocks(); });

describe("native timeline panel navigation integration", () => {
  it("uses the real panel URL behavior and restores virtualized trigger focus after Back", () => {
    const view = render(<PanelProvider orgSlug="org" workspaceSlug="workspace"><VirtualizedHarness /></PanelProvider>);
    const trigger = screen.getByRole("button", { name: "Open item" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(navigation.push).toHaveBeenCalledWith(
      "/org/workspace/roadmap?detail=roadmapItem%3Aitem-42",
      { scroll: false },
    );

    navigation.params = new URLSearchParams("detail=roadmapItem:item-42");
    view.rerender(<PanelProvider orgSlug="org" workspaceSlug="workspace"><VirtualizedHarness /></PanelProvider>);
    expect(screen.getByRole("button", { name: "Open item" })).toBeInTheDocument();

    navigation.params = new URLSearchParams();
    view.rerender(<PanelProvider orgSlug="org" workspaceSlug="workspace"><VirtualizedHarness /></PanelProvider>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open item" }));
  });
});
