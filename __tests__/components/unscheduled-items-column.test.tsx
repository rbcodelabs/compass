// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import "@testing-library/jest-dom/vitest";
import { UnscheduledItemsColumn } from "@/components/roadmap/unscheduled-items-panel";

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
