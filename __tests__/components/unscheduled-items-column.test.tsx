// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import "@testing-library/jest-dom/vitest";
import { UnscheduledItemsColumn } from "@/components/roadmap/unscheduled-items-panel";
import type { BoardColumnLayoutControls } from "@/components/patterns/board-pinned";

const openPanel = vi.fn();
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

afterEach(cleanup);

describe("UnscheduledItemsColumn", () => {
  it("renders as an always-visible kanban column with an empty state", () => {
    render(
      <DndContext>
        <UnscheduledItemsColumn items={[]} onQuickAdd={vi.fn()} />
      </DndContext>
    );

    const column = screen.getByTestId("roadmap-unscheduled-column");
    expect(within(column).getByRole("heading", { name: "Not scheduled" })).toBeInTheDocument();
    expect(within(column).getByText("0")).toBeInTheDocument();
    expect(within(column).getByText("No items waiting to be scheduled." )).toBeInTheDocument();
  });

  it("renders candidate cards at the full column width", () => {
    render(
      <DndContext>
        <UnscheduledItemsColumn
          items={[
            {
              kind: "feedback",
              id: "feedback-1",
              title: "Fix the broken export",
            },
          ]}
          onQuickAdd={vi.fn()}
        />
      </DndContext>
    );

    const column = screen.getByTestId("roadmap-unscheduled-column");
    expect(within(column).getByText("1")).toBeInTheDocument();
    expect(within(column).getByText("Fix the broken export").closest("[data-slot=card]")).toHaveClass("w-full");
  });

  it("opens the feedback detail panel when a card title is clicked", () => {
    openPanel.mockClear();
    render(
      <DndContext>
        <UnscheduledItemsColumn
          items={[
            {
              kind: "feedback",
              id: "feedback-1",
              title: "Fix the broken export",
            },
          ]}
          onQuickAdd={vi.fn()}
        />
      </DndContext>
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix the broken export" }));
    expect(openPanel).toHaveBeenCalledWith("feedback", "feedback-1");
  });
});

describe("UnscheduledItemsColumn as a pinnable column", () => {
  const items = [{ kind: "feedback" as const, id: "feedback-1", title: "Fix the broken export" }];
  const controls = (over: Partial<BoardColumnLayoutControls> = {}): BoardColumnLayoutControls => ({
    columnId: "unscheduled",
    label: "Not scheduled",
    pinned: true,
    pinnable: true,
    onTogglePin: vi.fn(),
    canMoveLeft: false,
    canMoveRight: false,
    onMove: vi.fn(),
    onCollapse: vi.fn(),
    ...over,
  });

  it("renders the same column in the pinned placement (fixed width, own scroll) and carries its header controls", () => {
    const layoutControls = controls();
    render(
      <DndContext>
        <UnscheduledItemsColumn items={items} onQuickAdd={vi.fn()} placement="pinned" layoutControls={layoutControls} />
      </DndContext>
    );
    const column = screen.getByTestId("roadmap-unscheduled-column");
    expect(column).toHaveClass("h-full", "w-72", "flex-none");
    expect(within(column).getByText("Fix the broken export")).toBeInTheDocument();

    fireEvent.click(within(column).getByRole("button", { name: "Collapse Not scheduled" }));
    expect(layoutControls.onCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(within(column).getByRole("button", { name: "Unpin Not scheduled" }));
    expect(layoutControls.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("in the scroller placement keeps the swipe-column sizing and shows no collapse control when it is not docked", () => {
    render(
      <DndContext>
        <UnscheduledItemsColumn items={items} onQuickAdd={vi.fn()} layoutControls={controls({ pinned: false, pinnable: false, onCollapse: undefined })} />
      </DndContext>
    );
    const column = screen.getByTestId("roadmap-unscheduled-column");
    expect(column.className).toContain("md:min-w-[280px]");
    expect(within(column).queryByRole("button", { name: "Collapse Not scheduled" })).not.toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: /^(Pin|Unpin) Not scheduled/ })).not.toBeInTheDocument();
  });
});
