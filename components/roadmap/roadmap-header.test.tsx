// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const url = vi.hoisted(() => ({ set: vi.fn() }));
// The header's saved-views menu imports the org-level saved-view actions, which pull in auth; stub them at the boundary.
vi.mock("@/app/[orgSlug]/roadmap/actions", () => ({
  createRoadmapViewAction: vi.fn(),
  updateRoadmapViewAction: vi.fn(),
  deleteRoadmapViewAction: vi.fn(),
}));

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
    expect(url.set).toHaveBeenCalledWith({ squad: null, field: null, fieldValue: null });
  });

  it("offers a radio group per filterable custom field and writes both filter params together", async () => {
    const customFieldGroups = [
      {
        fieldId: "field-area",
        label: "Product Area",
        objectType: "ROADMAP_ITEM" as const,
        options: [
          { value: "payments", label: "Payments", color: "#abc" },
          { value: "billing", label: "Billing", color: null },
        ],
      },
    ];
    render(<RoadmapHeader squads={squads} customFieldGroups={customFieldGroups} activeCustomFieldId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    expect(await screen.findByRole("menuitemradio", { name: "Payments" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Payments" }));
    expect(url.set).toHaveBeenCalledWith({ field: "field-area", fieldValue: "payments" });
  });

  it("clears both filter params when the custom-field group is set back to All", async () => {
    const customFieldGroups = [
      {
        fieldId: "field-area",
        label: "Product Area",
        objectType: "ROADMAP_ITEM" as const,
        options: [{ value: "payments", label: "Payments", color: null }],
      },
    ];
    render(<RoadmapHeader squads={squads} customFieldGroups={customFieldGroups} activeCustomFieldId="field-area" />);
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "All" }));
    expect(url.set).toHaveBeenCalledWith({ field: null, fieldValue: null });
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

describe("Ready-to-schedule rail toggle", () => {
  const rail = (over: Record<string, unknown> = {}) => ({ open: true, onToggle: vi.fn(), count: 3, autoAdded: 0, controlsId: "rail-region", ...over });
  const renderRail = (railProps = rail(), autoSync = true) => render(<RoadmapHeader squads={squads} timeline={{ zoom: "month", onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: false, schedule: { onOpen: vi.fn(), autoSync, rail: railProps } }} />);

  it("names the action for the current state and wires aria-expanded and aria-controls", () => {
    const { rerender } = renderRail();
    const hide = screen.getByRole("button", { name: "Hide ready-to-schedule rail" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(hide).toHaveAttribute("aria-controls", "rail-region");
    expect(hide).toHaveAttribute("aria-keyshortcuts", "[");
    rerender(<RoadmapHeader squads={squads} timeline={{ zoom: "month", onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: false, schedule: { onOpen: vi.fn(), autoSync: true, rail: rail({ open: false }) } }} />);
    expect(screen.getByRole("button", { name: "Show ready-to-schedule rail" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the unscheduled count on the button and describes it for screen readers", () => {
    renderRail(rail({ open: false, count: 7, autoAdded: 2 }));
    const button = screen.getByRole("button", { name: "Show ready-to-schedule rail" });
    expect(screen.getByTestId("rail-toggle-count")).toHaveTextContent("7");
    expect(button).toHaveAccessibleDescription("7 ready to schedule, 2 auto-added");
  });

  it("hides the badge when nothing is waiting", () => {
    renderRail(rail({ count: 0 }));
    expect(screen.queryByTestId("rail-toggle-count")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide ready-to-schedule rail" })).toHaveAccessibleDescription("Nothing waiting to schedule");
  });

  it("calls onToggle on click and shows a tooltip on focus", async () => {
    const props = rail();
    renderRail(props);
    const button = screen.getByRole("button", { name: "Hide ready-to-schedule rail" });
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Hide ready-to-schedule rail");
    fireEvent.click(button);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("surfaces auto-added items next to Auto-sync so they are noticed while the rail is closed", () => {
    renderRail(rail({ open: false, autoAdded: 2 }));
    expect(screen.getByTestId("auto-sync-indicator")).toHaveTextContent("2 added");
  });

  it("renders no toggle when the timeline has no rail", () => {
    renderRail(null as never);
    expect(screen.queryByRole("button", { name: /ready-to-schedule rail/ })).not.toBeInTheDocument();
  });
});
