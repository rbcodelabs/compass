// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { RoadmapCardData } from "../roadmap-card";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => navigation.params }));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));

import { EditDatesDialog, TimelineCard, useTimelinePanelNavigation } from "./timeline-shared";

afterEach(cleanup);

describe("useTimelinePanelNavigation", () => {
  it("retains the invoking item across panel focus and restores focus after browser Back", () => {
    const trigger = document.createElement("button");
    trigger.dataset.timelineItemId = "item-42";
    document.body.append(trigger);
    trigger.focus();
    const { result, rerender } = renderHook(() => useTimelinePanelNavigation());

    result.current.openItem("item-42");
    navigation.params = new URLSearchParams("detail=roadmapItem:item-42");
    rerender();
    expect(result.current.triggerItemId).toBe("item-42");

    navigation.params = new URLSearchParams();
    rerender();
    expect(document.activeElement).toBe(trigger);
    expect(result.current.triggerItemId).toBeNull();
    trigger.remove();
  });
});

describe("TimelineCard reduced motion", () => {
  it("disables the card and edit-control transitions when reduced motion is requested", () => {
    const item = {
      id: "item-1",
      title: "Native validation",
      horizon: "NOW",
      isPrivate: false,
      deliveryStatus: "NOT_STARTED",
    } as RoadmapCardData;

    render(
      <TimelineCard
        item={item}
        start="2026-09-01"
        end="2026-09-14"
        onOpen={vi.fn()}
        onEditDates={vi.fn()}
      />,
    );

    expect(screen.getByTestId("timeline-item-item-1")).toHaveClass("motion-reduce:transition-none");
    expect(screen.getByRole("button", { name: "Edit dates for Native validation" })).toHaveClass(
      "motion-reduce:transition-none", "size-6",
    );
  });

  it("communicates inclusive dates and overlap without relying on color", () => {
    const item = {
      id: "item-1", title: "Concurrent work", horizon: "NOW", isPrivate: false,
      deliveryStatus: "NOT_STARTED",
    } as RoadmapCardData;

    render(<TimelineCard item={item} start="2026-09-01" end="2026-09-14" overlapCount={2} onOpen={vi.fn()} onEditDates={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Open details for Concurrent work.*2026-09-01 through 2026-09-14.*overlaps 1 other item/i })).toBeInTheDocument();
    expect(screen.getByText("2 overlapping")).toBeInTheDocument();
  });
});

describe("EditDatesDialog save failures", () => {
  it("tells users to reload the page when reconciliation has locked editing", () => {
    const item = { id: "item-1", title: "Conflict", horizon: "NEXT" } as RoadmapCardData;
    render(<EditDatesDialog item={item} open disabled start="2026-09-01" end="2026-09-14" onOpenChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reload this page before another edit");
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
  });
  it("edits horizon and both inclusive dates through explicit controls", async () => {
    const item = { id: "item-1", title: "Keyboard schedule", horizon: "NEXT", isPrivate: false, deliveryStatus: "NOT_STARTED" } as RoadmapCardData;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditDatesDialog item={item} open start="2026-09-01" end="2026-09-14" onOpenChange={vi.fn()} onSave={onSave} />);

    expect(screen.getByRole("option", { name: "Now" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Horizon"), { target: { value: "NOW" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-02" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-16" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("NOW", "2026-09-02", "2026-09-16"));
  });

  it("keeps the dialog open and consumes a rejected optimistic save", async () => {
    const item = {
      id: "item-1",
      title: "Rollback validation",
      horizon: "NOW",
      isPrivate: false,
      deliveryStatus: "NOT_STARTED",
    } as RoadmapCardData;
    const onOpenChange = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("deterministic save failure"));

    render(
      <EditDatesDialog
        item={item}
        open
        start="2026-09-01"
        end="2026-09-14"
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save schedule" })).toBeEnabled());
    expect(onSave).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
