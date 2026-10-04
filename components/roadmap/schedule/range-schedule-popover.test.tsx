// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { RangeSchedulePopover } from "./range-schedule-popover";

const item = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "solution" as const, id, title: `Solution ${id}`, opportunityId: "opp-1", opportunityTitle: "Opp", squadId: null, status: "VALIDATED", score: 70, ...over,
});
const range = { start: "2026-08-03", end: "2026-08-28" };

afterEach(cleanup);

describe("RangeSchedulePopover", () => {
  it("names the drawn range and squad and lists the candidates in the order given", () => {
    render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={[item("a"), item("b", { status: "IN_DELIVERY", score: null })]} onPick={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Schedule from…" });
    expect(dialog).toHaveTextContent("Aug 3 – Aug 28 · Alpha");
    expect([...dialog.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Solution aValidated · 70", "Solution bIn delivery"]);
  });

  it("moves focus to the first choice, and arrow keys move between choices", () => {
    render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={[item("a"), item("b")]} onPick={vi.fn()} onClose={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(buttons[1], { key: "ArrowDown" });
    expect(buttons[0]).toHaveFocus();
  });

  it("picks a solution", () => {
    const onPick = vi.fn();
    render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={[item("a")]} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Solution a/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("closes on Escape and on a click outside, but not on a click inside", () => {
    const onClose = vi.fn();
    render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={[item("a")]} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says when there is nothing left to schedule and caps a long list", () => {
    const { unmount } = render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Nothing left to schedule.")).toBeInTheDocument();
    unmount();
    render(<RangeSchedulePopover anchor={{ x: 10, y: 10 }} range={range} squadLabel="Alpha" candidates={Array.from({ length: 9 }, (_, index) => item(`s${index}`))} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });
});
