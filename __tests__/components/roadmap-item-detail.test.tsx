// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  error: false,
  openPanel: vi.fn(),
  notify: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
  patch: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@/components/panels/panel-parts", async (original) => ({
  ...await original<typeof import("@/components/panels/panel-parts")>(),
  useEntityDetail: () => ({ data: state.data, error: state.error, mutate: state.mutate, refresh: state.refresh }),
  patchEntityField: state.patch,
}));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: state.openPanel, notifyEntityMutated: state.notify }) }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({ archiveItem: state.archive }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => <div>Discussion body</div> }));
vi.mock("@/components/following/follow-button", () => ({ FollowButton: () => <button>Follow</button> }));
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => <button>Request decision</button> }));
vi.mock("@/components/analytics/measurements-panel", () => ({ MeasurementsPanel: () => <div>Measurements body</div> }));
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => <div>Tasks body</div> }));
vi.mock("@/components/panels/launch-tier-picker", () => ({ LaunchTierPicker: () => <div>Tier picker</div> }));
vi.mock("@/components/panels/launch-checklist", () => ({ LaunchChecklist: () => null }));
vi.mock("@/components/panels/positioning-brief-row", () => ({ PositioningBriefRow: () => null }));
vi.mock("@/components/custom-fields/custom-fields-panel", () => ({ CustomFieldsPanel: () => <div>Custom fields body</div> }));
import { RoadmapItemDetail, toCardPatch } from "@/components/roadmap/roadmap-item-detail";

const base = () => ({
  id: "ri-1", workspaceId: "ws", title: "Ship guided setup", description: "Make setup easier", horizon: "NOW", status: "ACTIVE",
  isPrivate: false, startDate: null, endDate: null, updatedAt: "2026-09-23T00:00:00.000Z", squadId: null, opportunityId: null,
  squad: null, solution: null, keyResult: null, opportunity: null, experiment: null, feedback: null, launchChecklist: null,
  positioningBrief: null, launchWorkflowEnabled: true, deliveryTasks: [], linkableTasks: [], members: [],
  customFields: [{ id: "f" }], squads: [{ id: "sq-1", name: "Growth", color: "#123456" }],
  availableOpportunities: [{ id: "opp-1", title: "Setup is confusing" }], _count: { votes: 3 },
});

beforeEach(() => {
  document.cookie = "panel_sections=; path=/; max-age=0";
  state.data = base();
  state.error = false;
  state.patch.mockImplementation(async (_t, _i, _o, _w, field, value) => ({ data: { ...base(), [field]: value } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// The reader's disclosure choice is remembered between renders, so open it only if shut.
const openMore = () => { const b = screen.getByRole("button", { name: "More properties" }); if (b.getAttribute("aria-expanded") !== "true") fireEvent.click(b); };
const renderDetail = (variant: "panel" | "page" = "panel") => render(<RoadmapItemDetail itemId="ri-1" orgSlug="acme" workspaceSlug="product" variant={variant} />);

describe.each(["panel", "page"] as const)("RoadmapItemDetail (%s)", (variant) => {
  it("puts the title, one summary row and the description before the main sections", () => {
    renderDetail(variant);
    const root = document.querySelector('[data-slot="roadmap-item-detail"]')!;
    expect(root).toHaveAttribute("data-variant", variant);
    expect(root.className).toContain("@container");
    const summary = screen.getByLabelText("Roadmap item summary");
    expect(within(summary).getByRole("combobox", { name: "Horizon" })).toBeVisible();
    expect(within(summary).getByRole("combobox", { name: "Squad" })).toBeVisible();
    expect(within(summary).getByRole("button", { name: /Dates: not set/ })).toBeVisible();
    expect(within(summary).getByText("3 votes")).toBeVisible();
    expect(within(summary).getByText("Follow")).toBeVisible();
    expect(within(summary).getByText("Request decision")).toBeVisible();
    expect(screen.queryByText("Open full page")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ship guided setup");
  });

  it("keeps Launch, Delivery tasks and Linked to as plain sections and folds secondary fields", () => {
    renderDetail(variant);
    for (const label of ["Launch", "Delivery tasks", "Linked to", "Details"]) {
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    expect(screen.getByText("Measurements body")).toBeVisible();
    expect(screen.queryByText("Private (hidden from public roadmap)")).toBeNull();
    const disclosure = screen.getByRole("button", { name: "More properties" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByText("Private (hidden from public roadmap)")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Opportunity" })).toBeVisible();
  });

  it("lays discussion beside the content on wide containers and below on narrow ones", () => {
    renderDetail(variant);
    const aside = screen.getByRole("complementary", { name: "Roadmap item discussion" });
    expect(aside.className).toContain("@[801px]:border-l");
    expect(aside.parentElement!.className).toContain("grid-cols-1");
    expect(aside.parentElement!.className).toContain("@[801px]:grid-cols-[minmax(0,1fr)_310px]");
    expect(within(aside).getByText("Discussion body")).toBeVisible();
    expect(screen.getByRole("button", { name: "Discussion" })).toHaveAttribute("aria-controls", aside.id);
  });
});

describe("RoadmapItemDetail squad field", () => {
  it("renders one squad dot and keeps the full name reachable when it is long", () => {
    const name = "QA Squad Layout Check With A Very Long Descriptive Name";
    state.data = { ...base(), squadId: "sq-1", squads: [{ id: "sq-1", name, color: "#123456" }] };
    renderDetail("panel");
    const trigger = screen.getByRole("combobox", { name: "Squad" });
    expect(trigger).toHaveAttribute("title", name);
    expect(trigger.querySelectorAll("span[style*=\"background-color\"]")).toHaveLength(1);
    expect(within(trigger).getByText(name)).toHaveClass("truncate");
  });

  it("gives the full page a wider squad limit than the panel", () => {
    const wrapperClass = (variant: "panel" | "page") => {
      cleanup();
      renderDetail(variant);
      return screen.getByRole("combobox", { name: "Squad" }).closest("div")!.className;
    };
    expect(wrapperClass("panel")).toContain("max-w-56");
    expect(wrapperClass("page")).toContain("sm:max-w-80");
  });
});

describe("RoadmapItemDetail content rules", () => {
  it("hides Launch when the workflow is off and Details when there are no custom fields", () => {
    state.data = { ...base(), launchWorkflowEnabled: false, customFields: [] };
    renderDetail();
    expect(screen.queryByText("Launch")).toBeNull();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("shows private and archived state as read-only chips", () => {
    state.data = { ...base(), isPrivate: true, status: "ARCHIVED" };
    renderDetail();
    const summary = screen.getByLabelText("Roadmap item summary");
    expect(within(summary).getByText("Private")).toBeVisible();
    expect(screen.getByText("Archived")).toBeVisible();
    openMore();
    expect(screen.queryByRole("button", { name: "Archive item" })).toBeNull();
  });

  it("opens linked records through RelationList", () => {
    state.data = { ...base(), opportunity: { id: "opp-1", title: "Setup is confusing" }, solution: { id: "sol-1", title: "Guided setup" } };
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Guided setup/ }));
    expect(state.openPanel).toHaveBeenCalledWith("solution", "sol-1");
  });
});

describe("RoadmapItemDetail editing (covers everything the removed Edit dialog did)", () => {
  it("saves the privacy toggle through the entity patch path", async () => {
    renderDetail();
    openMore();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(state.patch).toHaveBeenCalledWith("roadmapItem", "ri-1", "acme", "product", "isPrivate", true));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    expect(state.notify).toHaveBeenCalledWith("roadmapItem", "ri-1", expect.objectContaining({ roadmapItem: expect.objectContaining({ isPrivate: true }) }));
  });

  it("saves a date range as a pair and refuses a lone date", async () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Dates: not set/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-07-01" } });
    expect(screen.getByRole("button", { name: "Save dates" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Set both dates");
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-07-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Save dates" }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledWith("roadmapItem", "ri-1", "acme", "product", "schedule", { startDate: "2026-07-01", endDate: "2026-07-31" }));
  });

  it("shows an existing range in UTC and can clear it", async () => {
    state.data = { ...base(), startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-07-31T00:00:00.000Z" };
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Dates: Jul 1, 2026 – Jul 31, 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear dates" }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledWith("roadmapItem", "ri-1", "acme", "product", "schedule", { startDate: null, endDate: null }));
  });

  it("surfaces a rejected save instead of silently dropping it", async () => {
    state.patch.mockRejectedValueOnce(new Error("save failed"));
    renderDetail();
    openMore();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByText("Could not save that change. Try again.")).toBeVisible();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("archives and tells the board to drop the card", async () => {
    state.archive.mockResolvedValue(undefined);
    renderDetail();
    openMore();
    fireEvent.click(screen.getByRole("button", { name: "Archive item" }));
    await waitFor(() => expect(state.archive).toHaveBeenCalledWith("ri-1", "ws"));
    await waitFor(() => expect(state.notify).toHaveBeenCalledWith("roadmapItem", "ri-1", { archived: true }));
  });

  it("builds a card patch carrying every field the board renders", () => {
    expect(toCardPatch(base() as never)).toMatchObject({ title: "Ship guided setup", horizon: "NOW", isPrivate: false, startDate: null, opportunityId: null, squad: null });
  });
});

describe("RoadmapItemDetail load errors", () => {
  it("offers a retry when the first load fails", () => {
    state.data = null as never;
    state.error = true;
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load roadmap item.");
    expect(screen.getByRole("button", { name: "Retry loading roadmap item" })).toBeVisible();
  });

  it("keeps the last loaded details and offers a refresh retry when a refresh fails", () => {
    state.error = true;
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Showing the last loaded details.");
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    expect(state.refresh).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ship guided setup");
  });
});

describe("RoadmapItemDetail title edits", () => {
  it("explains a blank title instead of failing silently, and keeps the old title", async () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Ship guided setup" }));
    const input = screen.getByRole("textbox", { name: "Edit title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("A title is required");
    expect(state.patch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ship guided setup" })).toBeVisible();
  });

  it("surfaces a rejected title save", async () => {
    state.patch.mockRejectedValueOnce(new Error("save failed"));
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Ship guided setup" }));
    const input = screen.getByRole("textbox", { name: "Edit title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/Could not save the title/)).toBeVisible();
  });
});
