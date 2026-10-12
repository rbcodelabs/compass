// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const url = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("@/hooks/use-url-state", () => ({ useUrlState: () => ({ params: new URLSearchParams("view=timeline&squad=alpha&item=details"), set: url.set }) }));
import { RoadmapHeader } from "./roadmap-header";
const squads = [{ id: "alpha", name: "Alpha", color: "#6366f1" }];
const timelineProps = (overrides: Partial<{ saving: boolean; onZoom: () => void }> = {}) => ({ zoom: "month" as const, onZoom: vi.fn(), onShift: vi.fn(), onToday: vi.fn(), saving: false, ...overrides });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Roadmap header on the shared workspace frame", () => {
  it("renders inside the shared workspace header with the view toggle in actions", () => {
    const { container } = render(<RoadmapHeader squads={squads} />);
    const header = container.querySelector('[data-slot="workspace-header"]');
    expect(header).not.toBeNull();
    expect(header).toContainElement(screen.getByRole("heading", { level: 1, name: "Roadmap" }));
    expect(header?.querySelector('[data-slot="workspace-header-actions"]')).toContainElement(screen.getByRole("tab", { name: "Board" }));
  });

  it.each(["Previous period", "Go to today", "Next period", "More actions"])("associates the %s focus tooltip with its actual button", async (name) => {
    render(<RoadmapHeader squads={squads} timeline={timelineProps()} />);
    const button = screen.getByRole("button", { name });
    act(() => button.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(name);
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("keeps reload in the overflow menu and disabled while changes are saving", async () => {
    render(<RoadmapHeader squads={squads} timeline={timelineProps({ saving: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const reload = await screen.findByRole("menuitem", { name: /Reload timeline/ });
    expect(reload).toHaveAttribute("aria-disabled", "true");
    expect(reload).toHaveTextContent("wait for changes to save");
  });

  it("shows only the filter on Board: no timeline controls and no overflow menu", async () => {
    render(<RoadmapHeader squads={squads} />);
    expect(screen.queryByRole("button", { name: "Go to today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("menuitemradio", { name: "Alpha" })).toBeChecked();
    expect(screen.queryByRole("menuitemradio", { name: "Quarter" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("menuitemradio", { name: "Payments" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Payments" }));
    expect(url.set).toHaveBeenCalledWith({ field: "field-area", fieldValue: "payments" });
  });

  it("clears the squad and both custom-field params together from the filter menu", async () => {
    const customFieldGroups = [
      {
        fieldId: "field-area",
        label: "Product Area",
        objectType: "ROADMAP_ITEM" as const,
        options: [{ value: "payments", label: "Payments", color: null }],
      },
    ];
    render(<RoadmapHeader squads={squads} customFieldGroups={customFieldGroups} activeCustomFieldId="field-area" />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear all" }));
    expect(url.set).toHaveBeenCalledWith({ squad: null, field: null, fieldValue: null });
  });

  it("forwards navigation and scale without changing squad or save state", async () => {
    const timeline = timelineProps();
    render(<RoadmapHeader squads={squads} timeline={timeline} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to today" }));
    expect(timeline.onShift.mock.calls).toEqual([[-1], [1]]);
    expect(timeline.onToday).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
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
