// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: ({ disabled }: { disabled?: boolean }) => ({
    attributes: {}, listeners: {}, setNodeRef: vi.fn(), setActivatorNodeRef: vi.fn(),
    transform: null, isDragging: false, disabled,
  }),
}));

const openPanel = vi.fn();
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

import { UnscheduledItemsPanel } from "./unscheduled-items-panel";

const item = { kind: "feedback" as const, id: "feedback-1", title: "Backlog item" };
afterEach(cleanup);

describe("UnscheduledItemsPanel native-safe extension", () => {
  it("preserves the existing quick-add horizons and drag behavior by default", () => {
    render(<UnscheduledItemsPanel items={[item]} onQuickAdd={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Drag to schedule" })).toHaveClass("touch-none");
    expect(screen.getByText("Backlog item")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Card actions" }));
    expect(screen.getByText("Add to Now")).toBeInTheDocument();
    expect(screen.getByText("Add to Next")).toBeInTheDocument();
    expect(screen.getByText("Add to Later")).toBeInTheDocument();
  });

  it("opens the feedback detail panel when the card title is clicked", () => {
    openPanel.mockClear();
    render(<UnscheduledItemsPanel items={[item]} onQuickAdd={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Backlog item" }));
    expect(openPanel).toHaveBeenCalledWith("feedback", "feedback-1");
  });

  it("limits destinations, exposes pending state, and keeps touch scrolling outside intentional handles", () => {
    const onQuickAdd = vi.fn();
    render(
      <UnscheduledItemsPanel
        items={[item]}
        onQuickAdd={onQuickAdd}
        allowedHorizons={["NEXT", "LATER"]}
        pendingItemKeys={new Set(["unscheduled:feedback:feedback-1"])}
        interactionMode="touch-safe"
      />,
    );
    const card = screen.getByTestId("unscheduled-item-feedback:feedback-1");
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(card).toHaveClass("touch-pan-y");
    expect(screen.getByRole("button", { name: "Drag to schedule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Drag to schedule" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "Backlog item" })).toBeDisabled();
    expect(screen.getByText("Scheduling…")).toBeInTheDocument();
  });

  it("suppresses duplicate quick actions while pending", () => {
    const onQuickAdd = vi.fn();
    render(<UnscheduledItemsPanel items={[item]} onQuickAdd={onQuickAdd} pendingItemKeys={new Set(["unscheduled:feedback:feedback-1"])} />);
    expect(screen.getByRole("button", { name: "Card actions" })).toBeDisabled();
    expect(screen.queryByText("Add to Now")).not.toBeInTheDocument();
    expect(onQuickAdd).not.toHaveBeenCalled();
  });
});
