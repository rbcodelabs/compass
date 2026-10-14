// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: ({ disabled, id }: { disabled?: boolean; id: string }) => ({
    attributes: { "data-drag-id": id }, listeners: {}, setNodeRef: vi.fn(), setActivatorNodeRef: vi.fn(),
    transform: null, isDragging: false, disabled,
  }),
}));
const openPanel = vi.fn();
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel }) }));

import { ScheduleRail } from "./schedule-rail";

const solution = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "solution" as const,
  id,
  title: `Solution ${id}`,
  opportunityId: "opp-1",
  opportunityTitle: "Opportunity one",
  squadId: null as string | null,
  status: "VALIDATED",
  score: null as number | null,
  ...over,
});
const squads = [{ id: "squad-a", name: "Alpha", color: "#222222" }];
const baseProps = () => ({
  items: [] as never[],
  squads,
  autoAdded: [] as never[],
  pendingItemKeys: new Set<string>(),
  onScheduleOne: vi.fn(),
  onBulkSchedule: vi.fn(),
  onQuickAddFeedback: vi.fn(),
  onUndoAuto: vi.fn(),
});

afterEach(() => { cleanup(); openPanel.mockClear(); });

describe("ScheduleRail", () => {
  const items = [
    solution("a", { opportunityId: "opp-1", opportunityTitle: "Opportunity one", score: 82, squadId: "squad-a" }),
    solution("b", { opportunityId: "opp-2", opportunityTitle: "Opportunity two", status: "IN_DELIVERY", score: 58 }),
    solution("c", { opportunityId: "opp-1", opportunityTitle: "Opportunity one", score: 71 }),
  ];

  it("groups solutions under their opportunity with status, score and squad chips and a count", () => {
    render(<ScheduleRail {...baseProps()} items={items as never[]} />);
    expect(screen.getByTestId("schedule-rail-count")).toHaveTextContent("3");
    const group = screen.getByRole("region", { name: "Opportunity one" });
    expect(within(group).getAllByRole("listitem")).toHaveLength(2);
    const card = screen.getByTestId("unscheduled-item-solution:a");
    expect(card).toHaveTextContent("Validated");
    expect(card).toHaveTextContent("82");
    expect(card).toHaveTextContent("Alpha");
    expect(screen.getByTestId("unscheduled-item-solution:b")).toHaveTextContent("In delivery");
    // Highest score first within a group.
    const titles = within(group).getAllByRole("button", { name: /^Solution/ }).map((button) => button.textContent);
    expect(titles).toEqual(["Solution a", "Solution c"]);
  });

  it("gives every card a drag handle on the unscheduled drag id and opens its details on click", () => {
    render(<ScheduleRail {...baseProps()} items={[items[0]] as never[]} />);
    const card = screen.getByTestId("unscheduled-item-solution:a");
    expect(within(card).getByRole("button", { name: "Drag to schedule" })).toHaveAttribute("data-drag-id", "unscheduled:solution:a");
    fireEvent.click(within(card).getByRole("button", { name: "Solution a" }));
    expect(openPanel).toHaveBeenCalledWith("solution", "a");
  });

  it("filters by search text across titles and opportunities", () => {
    render(<ScheduleRail {...baseProps()} items={items as never[]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the ready to schedule list" }), { target: { value: "two" } });
    expect(screen.queryByTestId("unscheduled-item-solution:a")).not.toBeInTheDocument();
    expect(screen.getByTestId("unscheduled-item-solution:b")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the ready to schedule list" }), { target: { value: "zzz" } });
    expect(screen.getByTestId("schedule-rail-empty")).toHaveTextContent("Nothing matches this filter.");
  });

  it("filters to Validated and to Scored 70+", () => {
    render(<ScheduleRail {...baseProps()} items={items as never[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Validated" }));
    expect(screen.getByRole("button", { name: "Validated" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("unscheduled-item-solution:b")).not.toBeInTheDocument();
    expect(screen.getByTestId("unscheduled-item-solution:a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scored 70+" }));
    expect(screen.queryByTestId("unscheduled-item-solution:b")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^unscheduled-item-solution:/).map((node) => node.getAttribute("data-testid"))).toEqual(["unscheduled-item-solution:a", "unscheduled-item-solution:c"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByTestId(/^unscheduled-item-solution:/)).toHaveLength(3);
  });

  it("has a keyboard-reachable Schedule button per card that schedules at the suggested slot", () => {
    const props = baseProps();
    render(<ScheduleRail {...props} items={[items[0]] as never[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule Solution a at the suggested slot" }));
    expect(props.onScheduleOne).toHaveBeenCalledWith(items[0]);
  });

  it("disables a card while its create is in flight", () => {
    render(<ScheduleRail {...baseProps()} items={[items[0]] as never[]} pendingItemKeys={new Set(["unscheduled:solution:a"])} />);
    expect(screen.getByRole("button", { name: "Schedule Solution a at the suggested slot" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Drag to schedule" })).toBeDisabled();
    expect(screen.getByTestId("unscheduled-item-solution:a")).toHaveAttribute("aria-busy", "true");
  });

  it("selecting cards reveals a bulk bar with Now / Next / Later / Auto-fit that schedules the selection", () => {
    const props = baseProps();
    render(<ScheduleRail {...props} items={items as never[]} />);
    expect(screen.queryByTestId("schedule-rail-bulk")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Solution a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Solution b" }));
    const bar = screen.getByTestId("schedule-rail-bulk");
    expect(bar).toHaveTextContent("2 selected");
    for (const label of ["Now", "Next", "Later", "Auto-fit"]) expect(within(bar).getByRole("button", { name: label })).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: "Next" }));
    expect(props.onBulkSchedule).toHaveBeenCalledWith([items[0], items[1]], "NEXT");
    expect(screen.queryByTestId("schedule-rail-bulk")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Solution c" }));
    fireEvent.click(within(screen.getByTestId("schedule-rail-bulk")).getByRole("button", { name: "Auto-fit" }));
    expect(props.onBulkSchedule).toHaveBeenLastCalledWith([items[2]], "AUTO");
  });

  it("lists auto-added items with an Undo for each", () => {
    const props = baseProps();
    const auto = [{ id: "auto-1", title: "Adoption dashboard", startDate: "2026-10-05T00:00:00.000Z" }];
    render(<ScheduleRail {...props} autoAdded={auto as never[]} items={[items[0]] as never[]} />);
    const section = screen.getByTestId("schedule-rail-auto");
    expect(section).toHaveTextContent("Auto-added · 1");
    expect(section).toHaveTextContent("Adoption dashboard");
    expect(section).toHaveTextContent("Moved to In delivery, added Oct 5");
    fireEvent.click(within(section).getByRole("button", { name: "Undo auto-add of Adoption dashboard" }));
    expect(props.onUndoAuto).toHaveBeenCalledWith(auto[0]);
  });

  it("keeps Bug feedback working: drag handle and Add to Now / Next / Later", () => {
    const props = baseProps();
    render(<ScheduleRail {...props} items={[{ kind: "feedback", id: "fb-1", title: "Login is broken" }] as never[]} />);
    const card = screen.getByTestId("unscheduled-item-feedback:fb-1");
    expect(within(card).getByRole("button", { name: "Drag to schedule" })).toHaveAttribute("data-drag-id", "unscheduled:feedback:fb-1");
    expect(card).toHaveTextContent("Bug");
    fireEvent.click(within(card).getByRole("button", { name: "Card actions" }));
    fireEvent.click(screen.getByText("Add to Next"));
    expect(props.onQuickAddFeedback).toHaveBeenCalledWith({ kind: "feedback", id: "fb-1", title: "Login is broken" }, "NEXT");
    fireEvent.click(within(card).getByRole("button", { name: "Login is broken" }));
    expect(openPanel).toHaveBeenCalledWith("feedback", "fb-1");
  });

  it("says everything is scheduled when the rail is empty", () => {
    render(<ScheduleRail {...baseProps()} />);
    expect(screen.getByTestId("schedule-rail-empty")).toHaveTextContent("Everything from Discovery is on the roadmap.");
  });
});
