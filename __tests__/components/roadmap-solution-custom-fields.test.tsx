// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * RoadmapItem and Solution have no detail *route* — a roadmap card, a timeline
 * bar and a discovery solution card all open the entity in its detail panel
 * instead. These tests pin the panels as the surface where their custom field
 * values can be set and cleared, which is what makes the shipped ROADMAP_ITEM
 * and SOLUTION tag filters able to return anything at all.
 */

const { detail, upsertFieldValue, refresh } = vi.hoisted(() => ({
  detail: { data: {} as Record<string, unknown> },
  upsertFieldValue: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn(),
}));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn(), notifyEntityMutated: vi.fn() }),
}));
vi.mock("@/components/panels/panel-parts", async (load) => ({
  ...(await load<typeof import("@/components/panels/panel-parts")>()),
  useEntityDetail: () => ({ data: detail.data, error: false, mutate: vi.fn(), refresh }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({ upsertFieldValue }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }));
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }));
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }));
vi.mock("@/components/analytics/measurements-panel", () => ({ MeasurementsPanel: () => null }));
vi.mock("@/components/panels/launch-tier-picker", () => ({ LaunchTierPicker: () => null }));
vi.mock("@/components/panels/launch-checklist", () => ({ LaunchChecklist: () => null }));
vi.mock("@/components/panels/positioning-brief-row", () => ({ PositioningBriefRow: () => null }));
vi.mock("@/components/panels/solution-assumptions", () => ({ SolutionAssumptions: () => null }));
vi.mock("@/components/panels/solution-plan-discussion", () => ({ SolutionPlanDiscussion: () => null }));
vi.mock("@/components/panels/solution-artifacts", () => ({ SolutionArtifacts: () => null }));
vi.mock("@/components/discovery/add-evidence-dialog", () => ({ AddEvidenceDialog: () => null }));
vi.mock("@/components/discovery/evidence-list", () => ({ EvidenceList: () => null }));
vi.mock("@/components/research/flesh-this-out-link", () => ({ FleshThisOutLink: () => null }));
vi.mock("@/components/research/pm-interview-history", () => ({ PmInterviewHistory: () => null }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({ promoteToRoadmap: vi.fn() }));

import { RoadmapItemPanel } from "@/components/panels/roadmap-item-panel";
import { SolutionPanel } from "@/components/panels/solution-panel";

const productArea = {
  id: "field-area",
  name: "Product Area",
  fieldType: "MULTI_SELECT" as const,
  options: [
    { label: "ZZ Alpha", value: "zz_alpha", color: null },
    { label: "ZZ Beta", value: "zz_beta", color: null },
  ],
  sharedOptionSetId: "set-1",
  sharedOptionSetName: "Product Area",
  required: false,
  order: 0,
};

const releaseStage = {
  id: "field-stage",
  name: "Release Stage",
  fieldType: "SELECT" as const,
  options: [
    { label: "ZZ Alpha", value: "zz_alpha", color: null },
    { label: "ZZ Beta", value: "zz_beta", color: null },
  ],
  sharedOptionSetId: "set-1",
  sharedOptionSetName: "Product Area",
  required: false,
  order: 1,
};

function roadmapItem(customFields: unknown[]) {
  return {
    id: "ri-1",
    workspaceId: "ws-1",
    title: "Payments revamp",
    description: null,
    horizon: "NOW",
    status: "ACTIVE",
    isPrivate: false,
    startDate: null,
    endDate: null,
    updatedAt: "2026-09-16T00:00:00.000Z",
    squad: null,
    solution: null,
    keyResult: null,
    opportunity: null,
    experiment: null,
    feedback: null,
    launchChecklist: null,
    positioningBrief: null,
    launchWorkflowEnabled: true,
    deliveryTasks: [],
    linkableTasks: [],
    members: [],
    _count: { votes: 0 },
    customFields,
  };
}

function solution(customFields: unknown[]) {
  return {
    id: "sol-1",
    title: "Self-serve export",
    description: null,
    status: "VALIDATED",
    opportunity: { id: "opp-1", title: "Exports are manual", workspaceId: "ws-1", squadId: null },
    assumptions: [],
    evidence: [],
    comments: [],
    roadmapItems: [],
    artifacts: [],
    availableArtifacts: [],
    deliveryTasks: [],
    linkableTasks: [],
    members: [],
    pmInterviews: [],
    pmInterviewEnabled: false,
    customFields,
  };
}

/**
 * One field's row in the Details section. Scoped rather than queried globally
 * because a panel's own title carries an editable status control of the same
 * role — the point of these tests is the custom field, not that one.
 */
function fieldRow(name: string): HTMLElement {
  return screen.getByText(name).closest("div.group\\/field") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("RoadmapItem custom fields", () => {
  it("renders the item's tag values, resolved to their shared-set labels", () => {
    detail.data = roadmapItem([{ ...productArea, objectType: "ROADMAP_ITEM", currentValue: ["zz_alpha"] }]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    expect(screen.getByText("Product Area")).toBeVisible();
    expect(screen.getByText("ZZ Alpha")).toBeVisible();
  });

  it("shows an untagged field as settable rather than hiding it", () => {
    detail.data = roadmapItem([{ ...productArea, objectType: "ROADMAP_ITEM", currentValue: null }]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    expect(screen.getByText("Empty")).toBeVisible();
  });

  it("writes a picked option against the roadmap item and reloads the panel", async () => {
    detail.data = roadmapItem([{ ...releaseStage, objectType: "ROADMAP_ITEM", currentValue: null }]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    const row = fieldRow("Release Stage");
    fireEvent.click(within(row).getByLabelText("Release Stage"));
    // Picked by its label; stored as its slug. The pairing the old free-text
    // editor could not enforce.
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Beta" }));

    await waitFor(() =>
      expect(upsertFieldValue).toHaveBeenCalledWith(
        "ri-1",
        "field-stage",
        "zz_beta",
        "/rbcodelabs/compass/roadmap"
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("offers the shared option set's list, not the field's own empty column", async () => {
    // Product Area borrows set-1. Its options reach the panel already resolved
    // by the read boundary, so the picker must simply render what it is given.
    detail.data = roadmapItem([{ ...productArea, objectType: "ROADMAP_ITEM", currentValue: null }]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    fireEvent.click(within(fieldRow("Product Area")).getByLabelText("Product Area"));

    expect(await screen.findByRole("option", { name: "ZZ Alpha" })).toBeVisible();
    expect(screen.getByRole("option", { name: "ZZ Beta" })).toBeVisible();

    fireEvent.click(screen.getByRole("option", { name: "ZZ Beta" }));
    await waitFor(() =>
      expect(upsertFieldValue).toHaveBeenCalledWith(
        "ri-1",
        "field-area",
        ["zz_beta"],
        "/rbcodelabs/compass/roadmap"
      )
    );
  });

  it("clears the value back to null from the row itself", async () => {
    detail.data = roadmapItem([{ ...releaseStage, objectType: "ROADMAP_ITEM", currentValue: "zz_beta" }]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    const row = fieldRow("Release Stage");
    fireEvent.click(within(row).getByRole("button", { name: "Clear Release Stage" }));

    await waitFor(() =>
      expect(upsertFieldValue).toHaveBeenCalledWith(
        "ri-1",
        "field-stage",
        null,
        "/rbcodelabs/compass/roadmap"
      )
    );
  });

  it("clears a multi-select field to empty", async () => {
    detail.data = roadmapItem([
      { ...productArea, objectType: "ROADMAP_ITEM", currentValue: ["zz_alpha", "zz_beta"] },
    ]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    fireEvent.click(
      within(fieldRow("Product Area")).getByRole("button", { name: "Clear Product Area" })
    );

    await waitFor(() =>
      expect(upsertFieldValue).toHaveBeenCalledWith(
        "ri-1",
        "field-area",
        [],
        "/rbcodelabs/compass/roadmap"
      )
    );
  });

  it("renders no Details section when the workspace defines no roadmap-item fields", () => {
    detail.data = roadmapItem([]);
    render(<RoadmapItemPanel id="ri-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });
});

describe("Solution custom fields", () => {
  it("renders the solution's tag values, resolved to their shared-set labels", () => {
    detail.data = solution([{ ...productArea, objectType: "SOLUTION", currentValue: ["zz_beta"] }]);
    render(<SolutionPanel id="sol-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    expect(screen.getByText("Product Area")).toBeVisible();
    expect(screen.getByText("ZZ Beta")).toBeVisible();
  });

  it("writes a picked option against the solution and revalidates its opportunity page", async () => {
    detail.data = solution([{ ...releaseStage, objectType: "SOLUTION", currentValue: null }]);
    render(<SolutionPanel id="sol-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    const row = fieldRow("Release Stage");
    fireEvent.click(within(row).getByLabelText("Release Stage"));
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Alpha" }));

    await waitFor(() =>
      expect(upsertFieldValue).toHaveBeenCalledWith(
        "sol-1",
        "field-stage",
        "zz_alpha",
        "/rbcodelabs/compass/discovery/opp-1"
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("renders no Details section when the workspace defines no solution fields", () => {
    detail.data = solution([]);
    render(<SolutionPanel id="sol-1" orgSlug="rbcodelabs" workspaceSlug="compass" />);

    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });
});
