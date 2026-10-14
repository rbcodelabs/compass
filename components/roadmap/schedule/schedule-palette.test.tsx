// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { SchedulePalette } from "./schedule-palette";
import type { CatalogSolution } from "@/lib/roadmap/rail";

const solution = (id: string, over: Partial<CatalogSolution> = {}): CatalogSolution => ({
  id,
  title: `Solution ${id}`,
  status: "VALIDATED",
  score: null,
  opportunityId: "opp-1",
  opportunityTitle: "Opportunity one",
  squadId: null,
  ...over,
});
const catalog = {
  solutions: [solution("a", { score: 90 }), solution("b", { score: 60 }), solution("c", { opportunityId: "opp-2", opportunityTitle: "Opportunity two", status: "IN_DELIVERY", score: 80 })],
  opportunities: [
    { id: "opp-1", title: "Opportunity one", squadId: null },
    { id: "opp-2", title: "Opportunity two", squadId: null },
  ],
};
const suggestSlot = vi.fn(() => ({ start: "2026-10-05", end: "2026-11-15" }));
const onSchedule = vi.fn(async (_solutions: CatalogSolution[], _dates: { startDate: string; weeks: number } | null) => undefined);
const onOpenChange = vi.fn();

function Harness({ scheduled = [] as string[] }: { scheduled?: string[] }) {
  const [open, setOpen] = useState(true);
  return <SchedulePalette open={open} onOpenChange={(value) => { onOpenChange(value); setOpen(value); }} catalog={catalog} scheduledIds={new Set(scheduled)} suggestSlot={suggestSlot} onSchedule={onSchedule} />;
}
const input = () => screen.getByRole("combobox", { name: /^Search/ });
const options = () => screen.getAllByRole("option");

beforeEach(() => { suggestSlot.mockClear(); onSchedule.mockClear(); onOpenChange.mockClear(); });
afterEach(cleanup);

describe("SchedulePalette", () => {
  it("is a modal dialog with a combobox bound to a listbox of options", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Schedule from discovery" });
    expect(dialog).toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(input()).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(options()[1]).toHaveAttribute("aria-selected", "false");
  });

  it("moves focus into the search box on open", async () => {
    render(<Harness />);
    await waitFor(() => expect(input()).toHaveFocus());
  });

  it("lists solutions by score and then opportunities, and filters as you type", () => {
    render(<Harness />);
    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining("Solution a"),
      expect.stringContaining("Solution c"),
      expect.stringContaining("Solution b"),
      expect.stringContaining("Opportunity one"),
      expect.stringContaining("Opportunity two"),
    ]);
    fireEvent.change(input(), { target: { value: "two" } });
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining("Solution c"), expect.stringContaining("Opportunity two")]);
    fireEvent.change(input(), { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches in Discovery.")).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp move the highlight and wrap around", () => {
    render(<Harness />);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(options()[options().length - 1]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter schedules the highlighted solution at the suggested slot (no explicit dates) and closes", async () => {
    render(<Harness />);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(onSchedule).toHaveBeenCalledWith([expect.objectContaining({ id: "a" })], null);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows already-scheduled solutions as scheduled and inert", () => {
    render(<Harness scheduled={["a"]} />);
    const scheduled = options().find((option) => option.textContent?.includes("Solution a"))!;
    expect(scheduled).toHaveTextContent("scheduled");
    expect(scheduled).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(scheduled);
    expect(onSchedule).not.toHaveBeenCalled();
    // The first row is now the best unscheduled solution, and Enter schedules that one.
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSchedule).toHaveBeenCalledWith([expect.objectContaining({ id: "c" })], null);
  });

  it("Enter on a highlighted scheduled row does nothing", () => {
    render(<Harness scheduled={["a"]} />);
    const index = options().findIndex((option) => option.textContent?.includes("Solution a"));
    for (let step = 0; step < index; step += 1) fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSchedule).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Shift+Enter schedules every unscheduled solution under the highlighted one's opportunity", async () => {
    render(<Harness scheduled={["b"]} />);
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(onSchedule).toHaveBeenCalled());
    // a and b share opp-1; b is already scheduled, so only a remains.
    expect(onSchedule).toHaveBeenCalledWith([expect.objectContaining({ id: "a" })], null);
  });

  it("choosing an opportunity row schedules all its unscheduled solutions", async () => {
    render(<Harness />);
    fireEvent.click(options().find((option) => option.textContent?.includes("Opportunity one") && option.textContent?.includes("schedules all"))!);
    await waitFor(() => expect(onSchedule).toHaveBeenCalled());
    expect(onSchedule.mock.calls[0][0].map((s: CatalogSolution) => s.id)).toEqual(["a", "b"]);
  });

  it("Tab reveals a start / length step prefilled from the suggested slot; Enter then passes the dates", async () => {
    render(<Harness />);
    expect(screen.queryByTestId("schedule-palette-dates")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Tab" });
    const dates = await screen.findByTestId("schedule-palette-dates");
    const start = within(dates).getByLabelText("Start") as HTMLInputElement;
    expect(start.value).toBe("2026-10-05");
    fireEvent.change(start, { target: { value: "2026-11-02" } });
    fireEvent.change(within(dates).getByLabelText("Length"), { target: { value: "8" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onSchedule).toHaveBeenCalled());
    expect(onSchedule).toHaveBeenCalledWith([expect.objectContaining({ id: "a" })], { startDate: "2026-11-02", weeks: 8 });
  });

  it("Escape closes the palette without scheduling", async () => {
    render(<Harness />);
    await act(async () => { fireEvent.keyDown(input(), { key: "Escape" }); });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSchedule).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
