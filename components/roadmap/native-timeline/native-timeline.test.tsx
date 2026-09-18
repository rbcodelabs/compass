// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/hooks/use-url-state", () => ({ useUrlState: () => ({ params: new URLSearchParams(), set: vi.fn() }) }));

type DndHarnessProps = {
  children: React.ReactNode;
  collisionDetection?: unknown;
  onDragStart?: (event: Record<string, unknown>) => void;
  onDragMove?: (event: Record<string, unknown>) => void;
  onDragCancel?: () => void;
  onDragEnd?: (event: Record<string, unknown>) => void;
};

const harness = vi.hoisted(() => ({
  pointerWithin: vi.fn(),
  dndProps: null as DndHarnessProps | null,
  controller: {
    items: [] as Array<{
      id: string;
      title: string;
      horizon: "NOW" | "NEXT" | "LATER" | "LAUNCHING" | "LAUNCHED" | "SHIPPED";
      squad: { id: string; name: string; color: string } | null;
      viewStart: string;
      viewEnd: string;
      hasDates: boolean;
    }>,
    unscheduled: [] as Array<{ kind: "feedback"; id: string; title: string }>,
    zoom: "month" as "month" | "quarter",
    setZoom: vi.fn(),
    viewportStart: "2026-07-01",
    viewportEnd: "2027-01-01",
    shiftViewport: vi.fn(),
    jumpToday: vi.fn(),
    reschedule: vi.fn(),
    pendingItemIds: new Set<string>(),
    reconciliationRequiredIds: new Set<string>(),
    pendingBacklogIds: new Set<string>(),
    scheduleBacklog: vi.fn(),
    quickAdd: vi.fn(),
    announcement: "Timeline ready",
    setAnnouncement: vi.fn(),
  },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: DndHarnessProps) => {
    harness.dndProps = props;
    return <>{props.children}</>;
  },
  PointerSensor: class {},
  pointerWithin: harness.pointerWithin,
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("../unscheduled-items-panel", () => ({
  UnscheduledItemsPanel: () => <div id="unscheduled-items-panel"><div data-slot="card" className="transition-opacity" /></div>,
  parseUnscheduledDragId: (dragId: string) => {
    const match = /^unscheduled:(solution|feedback):(.+)$/.exec(dragId);
    return match ? { kind: match[1], id: match[2] } : null;
  },
}));

vi.mock("./timeline-shared", () => ({
  EditDatesDialog: ({ item, onSave, disabled = false }: { item: { title: string; horizon: "NOW" | "NEXT" | "LATER" | "LAUNCHING" | "LAUNCHED" | "SHIPPED" } | null; onSave: (horizon: "NOW" | "NEXT" | "LATER" | "LAUNCHING" | "LAUNCHED" | "SHIPPED", start: string, end: string) => Promise<void>; disabled?: boolean }) => item ? <div role="dialog">Edit dates for {item.title}<button type="button" disabled={disabled} onClick={() => void onSave(item.horizon, "2026-07-10", "2026-07-20")}>Save schedule</button></div> : null,
  TimelineCard: ({ children, onEditDates, editControlClassName, editable = true, groupBadge }: { children: React.ReactNode; onEditDates: () => void; editControlClassName?: string; editable?: boolean; groupBadge?: { label: string; color: string | null } | null }) => (
    <div>
      {children}
      {groupBadge ? <span data-testid="group-badge">{groupBadge.label}</span> : null}
      {editable ? <button type="button" aria-label="Edit dates control" className={`size-6 ${editControlClassName ?? ""}`} onClick={onEditDates} /> : null}
    </div>
  ),
  TimelineToolbar: () => null,
  useTimelinePanelNavigation: () => ({ openItem: vi.fn(), triggerItemId: null }),
}));

vi.mock("./use-timeline-controller", () => ({
  useTimelineController: () => harness.controller,
  localCalendarToday: () => "2026-09-04",
}));

import { NativeTimeline } from "./native-timeline";
import { isInternalTimelineDestination } from "./timeline-model";

const resizeCallbacks = new Set<ResizeObserverCallback>();
let measuredClientWidth = 400;

class ResizeObserverStub implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}

function renderTimeline() {
  return render(
    <NativeTimeline
      items={[]}
      squads={[]}
      workspaceId="workspace-1"
      unscheduledItems={[]}
    />,
  );
}

it("places navigation and reload in the main Roadmap header without a second toolbar", () => {
  renderTimeline();
  const header = screen.getByRole("heading", { name: "Roadmap" }).closest("header");
  expect(header).toContainElement(screen.getByRole("button", { name: "Previous period" }));
  expect(header).toContainElement(screen.getByRole("button", { name: "Go to today" }));
  expect(header).toContainElement(screen.getByRole("button", { name: "Next period" }));
  expect(header).toContainElement(screen.getByRole("button", { name: "View options" }));
  expect(header).toContainElement(screen.getByRole("button", { name: "Reload timeline" }));
  expect(screen.queryByText("Reload to pick up deletions or conflicting changes made elsewhere.")).not.toBeInTheDocument();
});

beforeEach(() => {
  measuredClientWidth = 400;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => measuredClientWidth,
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  harness.dndProps = null;
  harness.controller.items = [];
  harness.controller.unscheduled = [];
  harness.controller.zoom = "month";
  harness.controller.reschedule.mockReset().mockResolvedValue(undefined);
  harness.controller.pendingItemIds = new Set();
  harness.controller.reconciliationRequiredIds = new Set();
  harness.controller.pendingBacklogIds = new Set();
  harness.controller.scheduleBacklog.mockReset().mockResolvedValue(undefined);
  harness.controller.setAnnouncement.mockReset();
});

afterEach(() => {
  cleanup();
  resizeCallbacks.clear();
});

describe("NativeTimeline", () => {
  it("offers visible reload recovery and prevents interrupting a pending save", () => {
    const { rerender } = renderTimeline();
    expect(screen.getByRole("button", { name: "Reload timeline" })).toBeEnabled();
    harness.controller.pendingItemIds = new Set(["saving"]);
    rerender(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} />);
    expect(screen.getByRole("button", { name: "Reload timeline" })).toBeDisabled();
    harness.controller.pendingItemIds = new Set();
    harness.controller.pendingBacklogIds = new Set(["scheduling"]);
    rerender(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} />);
    expect(screen.getByRole("button", { name: "Reload timeline" })).toBeDisabled();
  });
  it("shows a dotted move affordance and slim grips on both date borders", () => {
    harness.controller.items = [{ id: "item-1", title: "Compact controls", horizon: "NEXT", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-28", hasDates: true }];
    renderTimeline();

    const move = screen.getByRole("button", { name: "Move Compact controls" });
    expect(move.querySelector("svg.lucide-grip-vertical")).toBeInTheDocument();
    expect(move).not.toHaveClass("bg-black/10");
    expect(move).toHaveClass("ml-6", "w-6");
    expect(move).not.toHaveClass("mr-1");
    expect(screen.getByRole("button", { name: "Edit dates control" })).toHaveClass("mr-6");
    for (const edge of ["left", "right"]) {
      const resize = screen.getByRole("button", { name: `Resize ${edge} edge of Compact controls` });
      expect(resize).toHaveClass("w-6");
      expect(resize.querySelector('[data-resize-grip]')).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("resolves backlog drop lanes from the pointer instead of the translated card rectangle", () => {
    renderTimeline();

    expect(harness.dndProps?.collisionDetection).toBe(harness.pointerWithin);
  });

  it("still announces an invalid external backlog lane", () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Invalid lane" }];
    renderTimeline();

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      delta: { x: 12, y: 0 },
      over: { id: "horizon:NOW" },
    }));

    expect(harness.controller.setAnnouncement).toHaveBeenCalledWith("Invalid lane cannot be scheduled in that lane");
    expect(harness.controller.scheduleBacklog).not.toHaveBeenCalled();
  });

  it("allows a valid atomic exit from Now", () => {
    harness.controller.items = [{
      id: "item-1",
      title: "Internal move",
      horizon: "NOW",
      squad: null,
      viewStart: "2026-07-10",
      viewEnd: "2026-07-10",
      hasDates: true,
    }];
    renderTimeline();

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "timeline:item:item-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "timeline:item:item-1" },
      delta: { x: 12, y: 80 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NEXT", "2026-07-11", "2026-07-11");
  });

  it("allows entry to Now while launch horizons remain display-only", () => {
    expect(isInternalTimelineDestination("NEXT", "NOW")).toBe(true);
    harness.controller.items = [{
      id: "item-1", title: "Protected", horizon: "NEXT", squad: null,
      viewStart: "2026-07-10", viewEnd: "2026-07-10", hasDates: true,
    }];
    renderTimeline();
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "timeline:item:item-1" }, delta: { x: 0, y: 80 }, over: { id: "lane:NOW:unassigned" },
    }));
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NOW", "2026-07-10", "2026-07-10");
  });

  it("consumes an already-rolled-back internal move rejection at the drag boundary", async () => {
    harness.controller.items = [{
      id: "item-1",
      title: "Rejected internal move",
      horizon: "NOW",
      squad: null,
      viewStart: "2026-07-10",
      viewEnd: "2026-07-10",
      hasDates: true,
    }];
    const rejectedSave = Promise.reject(new Error("deterministic move failure"));
    const catchRejectedSave = vi.spyOn(rejectedSave, "catch");
    void rejectedSave.catch(() => undefined);
    catchRejectedSave.mockClear();
    harness.controller.reschedule.mockReturnValue(rejectedSave);
    renderTimeline();

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "timeline:item:item-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "timeline:item:item-1" },
      delta: { x: 12, y: 0 },
      over: null,
    }));

    await waitFor(() => expect(harness.controller.reschedule).toHaveBeenCalledOnce());
    expect(catchRejectedSave).toHaveBeenCalledOnce();
  });

  it("consumes an already-rolled-back resize rejection at the pointer boundary", async () => {
    harness.controller.items = [{
      id: "item-1",
      title: "Rejected resize",
      horizon: "NOW",
      squad: null,
      viewStart: "2026-07-10",
      viewEnd: "2026-07-20",
      hasDates: true,
    }];
    const rejectedSave = Promise.reject(new Error("deterministic resize failure"));
    const catchRejectedSave = vi.spyOn(rejectedSave, "catch");
    void rejectedSave.catch(() => undefined);
    catchRejectedSave.mockClear();
    harness.controller.reschedule.mockReturnValue(rejectedSave);
    renderTimeline();
    const leftResize = screen.getByRole("button", { name: "Resize left edge of Rejected resize" });

    fireEvent.pointerDown(leftResize, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(leftResize, { clientX: 132, pointerId: 1 });

    await waitFor(() => expect(harness.controller.reschedule).toHaveBeenCalledWith(
      "item-1",
      "NOW",
      "2026-07-11",
      "2026-07-20",
    ));
    expect(catchRejectedSave).toHaveBeenCalledOnce();
  });

  it("exposes the horizontal timeline as a named keyboard-focusable region", () => {
    renderTimeline();

    const scrollRegion = screen.getByRole("region", { name: "Timeline dates" });
    expect(scrollRegion).toHaveAttribute("tabindex", "0");
  });

  it("suppresses shared backlog card transitions under reduced motion without changing the shared panel", () => {
    renderTimeline();

    expect(screen.getByTestId("timeline-engine-native")).toHaveClass(
      "motion-reduce:[&_#unscheduled-items-panel_[data-slot=card]]:transition-none",
    );
  });

  it("measures a bounded window before paint and refreshes it after resize and zoom", () => {
    harness.controller.items = [{
      id: "item-1",
      title: "Measured item",
      horizon: "NOW",
      squad: null,
      viewStart: "2026-07-10",
      viewEnd: "2026-07-20",
      hasDates: true,
    }];
    const { rerender } = renderTimeline();
    const scrollRegion = screen.getByTestId("native-timeline-scroll");

    expect(scrollRegion).toHaveAttribute("data-measurement-timing", "pre-paint");
    expect(scrollRegion).toHaveAttribute("data-viewport-width-px", "400");
    expect(screen.getByTestId("timeline-grid")).toHaveAttribute("data-rendered-card-count", "1");

    measuredClientWidth = 640;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(scrollRegion).toHaveAttribute("data-viewport-width-px", "640");

    harness.controller.zoom = "quarter";
    rerender(
      <NativeTimeline
        items={[]}
        squads={[]}
        workspaceId="workspace-1"
        unscheduledItems={[]}
      />,
    );
    expect(screen.getByTestId("native-timeline-scroll")).toHaveAttribute("data-viewport-width-px", "640");
    expect(screen.getByTestId("native-timeline-scroll").firstElementChild).toHaveAttribute("data-logical-width-px", "736");
  });

  it("clips edge-overlapping cards at the logical grid so they cannot extend the scroll canvas", () => {
    renderTimeline();

    expect(screen.getByTestId("timeline-grid")).toHaveClass("overflow-hidden");
  });

  it("stacks inclusive same-lane collisions and expands the lane", () => {
    harness.controller.items = [
      { id: "a", title: "First", horizon: "NOW", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-12", hasDates: true },
      { id: "b", title: "Second", horizon: "NOW", squad: null, viewStart: "2026-07-12", viewEnd: "2026-07-14", hasDates: true },
    ];
    renderTimeline();

    expect(screen.getByTestId("timeline-item-position-a")).toHaveAttribute("data-track", "0");
    expect(screen.getByTestId("timeline-item-position-b")).toHaveAttribute("data-track", "1");
    expect(screen.getByTestId("timeline-drop-lane:NOW:unassigned")).toHaveStyle({ height: "86px" });
  });

  it("keeps card DOM order aligned with visual row order and chronology", () => {
    harness.controller.items = [
      { id: "next", title: "Next", horizon: "NEXT", squad: null, viewStart: "2026-07-01", viewEnd: "2026-07-02", hasDates: true },
      { id: "now-late", title: "Now late", horizon: "NOW", squad: null, viewStart: "2026-07-12", viewEnd: "2026-07-14", hasDates: true },
      { id: "now-early", title: "Now early", horizon: "NOW", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-11", hasDates: true },
    ];
    renderTimeline();

    expect(screen.getAllByTestId(/timeline-item-position-/).map((element) => element.dataset.timelineItemId))
      .toEqual(["now-early", "now-late", "next"]);
  });

  it("prevents another edit while the item has an optimistic save pending", () => {
    harness.controller.items = [{ id: "item-1", title: "Pending", horizon: "NOW", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true }];
    harness.controller.pendingItemIds = new Set(["item-1"]);
    renderTimeline();

    expect(screen.getByRole("button", { name: "Move Pending" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resize left edge of Pending" })).toBeDisabled();
  });

  it("removes every schedule control while reconciliation is required", () => {
    harness.controller.items = [{ id: "item-1", title: "Conflicted", horizon: "NEXT", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true }];
    harness.controller.reconciliationRequiredIds = new Set(["item-1"]);
    renderTimeline();

    expect(screen.getByRole("button", { name: "Move Conflicted" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resize left edge of Conflicted" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resize right edge of Conflicted" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit dates control" })).not.toBeInTheDocument();
  });

  it("blocks an already-open schedule dialog when reconciliation becomes required", () => {
    harness.controller.items = [{ id: "item-1", title: "Conflicted", horizon: "NEXT", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true }];
    const view = renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "Edit dates control" }));

    harness.controller.reconciliationRequiredIds = new Set(["item-1"]);
    view.rerender(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} />);

    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(harness.controller.reschedule).not.toHaveBeenCalled();
  });

  it("announces the destination dates, horizon, and overlap outcome during drag preview", () => {
    harness.controller.items = [
      { id: "item-1", title: "Moving", horizon: "NOW", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-12", hasDates: true },
      { id: "item-2", title: "Existing", horizon: "NEXT", squad: null, viewStart: "2026-07-11", viewEnd: "2026-07-13", hasDates: true },
    ];
    renderTimeline();

    act(() => harness.dndProps?.onDragMove?.({
      active: { id: "timeline:item:item-1" },
      delta: { x: 12, y: 80 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.setAnnouncement).toHaveBeenCalledWith(
      "Moving preview: NEXT, 2026-07-11 through 2026-07-13, overlaps 1 other item",
    );
  });

  it("schedules backlog from the current drag pointer instead of the card center", () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Pointer placement" }];
    renderTimeline();
    const canvas = screen.getByTestId("native-timeline-scroll").firstElementChild as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -100 } as DOMRect);

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 120 }),
    }));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 600 })));
    act(() => harness.dndProps?.onDragEnd?.({
      active: {
        id: "unscheduled:feedback:feedback-1",
        rect: { current: { translated: { left: 0, width: 100 } } },
      },
      delta: { x: 480, y: 0 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.scheduleBacklog).toHaveBeenCalledWith(
      harness.controller.unscheduled[0],
      "NEXT",
      "2026-08-28",
    );
  });

  it("does not double-count the horizontal activation threshold in the dropped date", () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Threshold placement" }];
    renderTimeline();
    const canvas = screen.getByTestId("native-timeline-scroll").firstElementChild as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -100 } as DOMRect);

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      // Pointerdown was 200; dnd-kit activates after the 12px move at 212.
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 812 })));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      // dnd-kit reports the total movement from pointerdown (812 - 200).
      delta: { x: 612, y: 0 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.scheduleBacklog).toHaveBeenCalledWith(
      harness.controller.unscheduled[0],
      "NEXT",
      "2026-09-15",
    );
  });

  it("uses the latest native touch coordinate for backlog placement", () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Touch placement" }];
    renderTimeline();
    const canvas = screen.getByTestId("native-timeline-scroll").firstElementChild as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -100 } as DOMRect);

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    const touchMove = new Event("touchmove");
    Object.defineProperty(touchMove, "touches", { value: [{ clientX: 812 }] });
    act(() => window.dispatchEvent(touchMove));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      delta: { x: 612, y: 0 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.scheduleBacklog).toHaveBeenCalledWith(
      harness.controller.unscheduled[0],
      "NEXT",
      "2026-09-15",
    );
  });

  it("falls back to the native activator coordinate when no later move event arrives", () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Fallback placement" }];
    renderTimeline();
    const canvas = screen.getByTestId("native-timeline-scroll").firstElementChild as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -100 } as DOMRect);

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 812 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      delta: { x: 612, y: 0 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    expect(harness.controller.scheduleBacklog).toHaveBeenCalledWith(
      harness.controller.unscheduled[0],
      "NEXT",
      "2026-09-15",
    );
  });

  it("removes native pointer and touch tracking listeners when a drag is cancelled", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    renderTimeline();

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    expect(addListener).toHaveBeenCalledWith("pointermove", expect.any(Function), true);
    expect(addListener).toHaveBeenCalledWith("touchmove", expect.any(Function), true);

    act(() => harness.dndProps?.onDragCancel?.());
    expect(harness.controller.reschedule).not.toHaveBeenCalled();
    expect(harness.controller.scheduleBacklog).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function), true);
    expect(removeListener).toHaveBeenCalledWith("touchmove", expect.any(Function), true);

    removeListener.mockClear();
    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "timeline:item:missing" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "timeline:item:missing" },
      delta: { x: 0, y: 0 },
      over: null,
    }));
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function), true);
    expect(removeListener).toHaveBeenCalledWith("touchmove", expect.any(Function), true);
  });

  it("consumes an already-announced backlog scheduling rejection at the drag boundary", async () => {
    harness.controller.unscheduled = [{ kind: "feedback", id: "feedback-1", title: "Rejected placement" }];
    harness.controller.scheduleBacklog.mockRejectedValue(new Error("deterministic schedule failure"));
    renderTimeline();
    const canvas = screen.getByTestId("native-timeline-scroll").firstElementChild as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0 } as DOMRect);

    act(() => harness.dndProps?.onDragStart?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 120 }),
    }));
    act(() => harness.dndProps?.onDragEnd?.({
      active: { id: "unscheduled:feedback:feedback-1" },
      delta: { x: 0, y: 0 },
      over: { id: "lane:NEXT:unassigned" },
    }));

    await waitFor(() => expect(harness.controller.scheduleBacklog).toHaveBeenCalledOnce());
  });

  it("uses exact one-day geometry with a non-overlapping 44px schedule-dialog fallback", () => {
    harness.controller.items = [{
      id: "item-1",
      title: "Touch targets",
      horizon: "NOW",
      squad: null,
      viewStart: "2026-07-10",
      viewEnd: "2026-07-10",
      hasDates: true,
    }];
    renderTimeline();

    const item = document.querySelector<HTMLElement>('[data-timeline-item-id="item-1"]');
    const editDates = screen.getByRole("button", { name: "Edit schedule for Touch targets" });

    expect(item).toHaveAttribute("data-visual-width", "12");
    expect(item).toHaveStyle({ width: "44px" });
    expect(screen.queryByRole("button", { name: "Move Touch targets" })).not.toBeInTheDocument();
    expect(editDates).toHaveClass("size-11");
    fireEvent.click(editDates);
    expect(screen.getByRole("dialog")).toHaveTextContent("Edit dates for Touch targets");
  });

  it.each([
    ["2026-07-17", "96"],
    ["2026-07-18", "108"],
    ["2026-07-19", "120"],
  ])("uses the single dialog until the four controls and details target fit (%s)", (viewEnd, width) => {
    harness.controller.items = [{
      id: "item-1", title: "Narrow controls", horizon: "NOW", squad: null,
      viewStart: "2026-07-10", viewEnd, hasDates: true,
    }];
    renderTimeline();

    expect(screen.getByTestId("timeline-item-position-item-1")).toHaveAttribute("data-visual-width", width);
    expect(screen.getByRole("button", { name: "Edit schedule for Narrow controls" })).toHaveClass("size-11");
    expect(screen.queryByRole("button", { name: "Move Narrow controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resize right edge of Narrow controls" })).not.toBeInTheDocument();
  });

  it("renders launching and launched items without schedule affordances", () => {
    harness.controller.items = [
      { id: "launching", title: "Launching item", horizon: "LAUNCHING", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true },
      { id: "launched", title: "Launched item", horizon: "LAUNCHED", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true },
    ];
    renderTimeline();

    expect(screen.queryAllByRole("button", { name: /Move (Launching|Launched) item/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Resize .* edge of (Launching|Launched) item/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Edit dates for (Launching|Launched) item/ })).toHaveLength(0);
  });

  it("packs consecutive one-day items according to minimum visual geometry at both zooms", () => {
    harness.controller.items = [
      { id: "a", title: "First", horizon: "NOW", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-10", hasDates: true },
      { id: "b", title: "Second", horizon: "NOW", squad: null, viewStart: "2026-07-11", viewEnd: "2026-07-11", hasDates: true },
    ];
    const { rerender } = renderTimeline();
    expect(screen.getByTestId("timeline-item-position-b")).toHaveAttribute("data-track", "1");
    harness.controller.zoom = "quarter";
    rerender(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} />);
    expect(screen.getByTestId("timeline-item-position-b")).toHaveAttribute("data-track", "1");
  });

  it("supports keyboard date moves, legal horizon moves, both edge resizes, and date editing", () => {
    harness.controller.items = [{ id: "item-1", title: "Keyboard", horizon: "NEXT", squad: null, viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true }];
    renderTimeline();
    const move = screen.getByRole("button", { name: "Move Keyboard" });
    fireEvent.keyDown(move, { key: "ArrowRight", altKey: true });
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NEXT", "2026-07-11", "2026-07-21");
    fireEvent.keyDown(move, { key: "ArrowDown", altKey: true });
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "LATER", "2026-07-10", "2026-07-20");
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize left edge of Keyboard" }), { key: "ArrowLeft" });
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NEXT", "2026-07-09", "2026-07-20");
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize right edge of Keyboard" }), { key: "ArrowRight" });
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NEXT", "2026-07-10", "2026-07-21");
    fireEvent.keyDown(move, { key: "d" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Edit dates for Keyboard");
  });

  it("preserves dates for vertical-only moves and does not clamp horizontal moves to the viewport", () => {
    harness.controller.items = [{ id: "item-1", title: "Unclamped", horizon: "NOW", squad: null, viewStart: "2026-07-01", viewEnd: "2026-07-02", hasDates: true }];
    renderTimeline();
    act(() => harness.dndProps?.onDragEnd?.({ active: { id: "timeline:item:item-1" }, delta: { x: 0, y: 20 }, over: { id: "lane:NEXT:unassigned" } }));
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NEXT", "2026-07-01", "2026-07-02");
    act(() => harness.dndProps?.onDragEnd?.({ active: { id: "timeline:item:item-1" }, delta: { x: -24, y: 0 }, over: null }));
    expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NOW", "2026-06-29", "2026-06-30");
  });

  describe("configurable grouping", () => {
    it("keeps horizon unchanged on drop when grouping is Squad (disable drag-to-regroup)", () => {
      harness.controller.items = [{
        id: "item-1", title: "Squad grouped", horizon: "NOW", squad: null,
        viewStart: "2026-07-10", viewEnd: "2026-07-10", hasDates: true,
      }];
      render(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} groupBy="squad" />);

      act(() => harness.dndProps?.onDragStart?.({
        active: { id: "timeline:item:item-1" },
        activatorEvent: new MouseEvent("pointerdown", { clientX: 212 }),
      }));
      act(() => harness.dndProps?.onDragEnd?.({
        active: { id: "timeline:item:item-1" },
        delta: { x: 12, y: 0 },
        over: { id: "lane:no-squad:__self__" },
      }));

      expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "NOW", "2026-07-11", "2026-07-11");
    });

    it("keeps horizon unchanged on drop when grouping is None", () => {
      harness.controller.items = [{
        id: "item-1", title: "Flat grouped", horizon: "LATER", squad: null,
        viewStart: "2026-07-10", viewEnd: "2026-07-10", hasDates: true,
      }];
      render(<NativeTimeline items={[]} squads={[]} workspaceId="workspace-1" unscheduledItems={[]} groupBy="none" />);

      act(() => harness.dndProps?.onDragEnd?.({
        active: { id: "timeline:item:item-1" },
        delta: { x: 12, y: 0 },
        over: { id: "lane:__all__:unassigned" },
      }));

      expect(harness.controller.reschedule).toHaveBeenCalledWith("item-1", "LATER", "2026-07-11", "2026-07-11");
    });

    it("still blocks a drop into a different squad's row when grouping is Squad", () => {
      harness.controller.items = [{
        id: "item-1", title: "Guarded", horizon: "NOW", squad: { id: "squad-a", name: "Alpha", color: "#111" },
        viewStart: "2026-07-10", viewEnd: "2026-07-10", hasDates: true,
      }];
      render(
        <NativeTimeline
          items={[]}
          squads={[{ id: "squad-a", name: "Alpha", color: "#111" }, { id: "squad-b", name: "Bravo", color: "#222" }]}
          workspaceId="workspace-1"
          unscheduledItems={[]}
          groupBy="squad"
        />,
      );

      act(() => harness.dndProps?.onDragEnd?.({
        active: { id: "timeline:item:item-1" },
        delta: { x: 12, y: 0 },
        over: { id: "lane:squad-b:__self__" },
      }));

      expect(harness.controller.setAnnouncement).toHaveBeenCalledWith("Guarded cannot move to a different squad from the timeline");
      expect(harness.controller.reschedule).not.toHaveBeenCalled();
    });

    it("renders squad headers with no phase rows when grouping is Squad", () => {
      harness.controller.items = [];
      render(
        <NativeTimeline
          items={[]}
          squads={[{ id: "squad-a", name: "Alpha", color: "#111" }]}
          workspaceId="workspace-1"
          unscheduledItems={[]}
          groupBy="squad"
        />,
      );

      expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
      expect(screen.queryByText("Now")).not.toBeInTheDocument();
      expect(screen.getAllByText("No squad").length).toBeGreaterThan(0);
    });

    it("renders no header rows at all when grouping is None", () => {
      harness.controller.items = [];
      render(
        <NativeTimeline
          items={[]}
          squads={[{ id: "squad-a", name: "Alpha", color: "#111" }]}
          workspaceId="workspace-1"
          unscheduledItems={[]}
          groupBy="none"
        />,
      );

      expect(screen.queryByText("Now")).not.toBeInTheDocument();
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });

    it("shows a custom-field-value badge on a card when grouping by that field", () => {
      harness.controller.items = [{
        id: "item-1", title: "Tagged", horizon: "NOW", squad: null,
        viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true,
      }];
      render(
        <NativeTimeline
          items={[]}
          squads={[]}
          workspaceId="workspace-1"
          unscheduledItems={[]}
          groupBy="customField"
          groupByField={{ id: "field-1", name: "Product Area", options: [{ label: "Payments", value: "payments", color: "#ff0000" }] }}
          customFieldValuesByItemId={{ "item-1": "payments" }}
        />,
      );

      expect(screen.getByTestId("group-badge")).toHaveTextContent("Payments");
    });

    it("shows no badge for an item with no value or an unknown value", () => {
      harness.controller.items = [{
        id: "item-1", title: "Untagged", horizon: "NOW", squad: null,
        viewStart: "2026-07-10", viewEnd: "2026-07-20", hasDates: true,
      }];
      render(
        <NativeTimeline
          items={[]}
          squads={[]}
          workspaceId="workspace-1"
          unscheduledItems={[]}
          groupBy="customField"
          groupByField={{ id: "field-1", name: "Product Area", options: [{ label: "Payments", value: "payments", color: "#ff0000" }] }}
          customFieldValuesByItemId={{}}
        />,
      );

      expect(screen.queryByTestId("group-badge")).not.toBeInTheDocument();
    });
  });
});
