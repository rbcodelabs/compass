// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const url = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("@/hooks/use-url-state", () => ({ useUrlState: () => ({ params: new URLSearchParams("view=timeline&squad=alpha&item=details"), set: url.set }) }));
import { RoadmapHeader } from "./roadmap-header";
const squads = [{ id: "alpha", name: "Alpha", color: "#6366f1" }];
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Roadmap compact header", () => {
  it.each(["Previous period", "Go to today", "Next period", "View options", "Reload timeline"])("associates the %s focus tooltip with its actual button", async (name) => {
    render(<RoadmapHeader squads={squads} timeline={{ zoom: "month", onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: false }} />);
    const button = screen.getByRole("button", { name });
    act(() => button.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(name);
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);
  });
  it("keeps reload disabled while explaining pending saves on wrapper focus", async () => {
    render(<RoadmapHeader squads={squads} timeline={{ zoom: "month", onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: true }} />);
    expect(screen.getByRole("button", { name: "Reload timeline" })).toBeDisabled();
    act(() => screen.getByLabelText("Saving changes; reload is unavailable").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Wait for changes to save before reloading");
    expect(screen.getByLabelText("Saving changes; reload is unavailable")).toHaveAttribute("aria-describedby", tooltip.id);
  });
  it("shows only squad options on Board", async () => {
    render(<RoadmapHeader squads={squads} />);
    expect(screen.queryByRole("button", { name: "Go to today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload timeline" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    expect(await screen.findByRole("menuitemradio", { name: "Alpha" })).toBeChecked();
    expect(screen.queryByRole("menuitemradio", { name: "Quarter" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear filters" }));
    expect(url.set).toHaveBeenCalledWith({ squad: null });
  });

  it("forwards navigation and scale without changing squad or save state", async () => {
    const timeline = { zoom: "month" as const, onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: false };
    render(<RoadmapHeader squads={squads} timeline={timeline} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to today" }));
    expect(timeline.onShift.mock.calls).toEqual([[-1], [1]]);
    expect(timeline.onToday).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Quarter" }));
    expect(timeline.onZoom).toHaveBeenCalledWith("quarter");
    expect(url.set).not.toHaveBeenCalled();
  });
});
