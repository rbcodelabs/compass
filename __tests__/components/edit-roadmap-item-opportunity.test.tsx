// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { updateRoadmapItemMock, updateRoadmapItemOpportunityMock } = vi.hoisted(() => ({
  updateRoadmapItemMock: vi.fn(),
  updateRoadmapItemOpportunityMock: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  updateRoadmapItem: updateRoadmapItemMock,
  updateRoadmapItemOpportunity: updateRoadmapItemOpportunityMock,
}));

import { EditItemDialog } from "@/components/roadmap/edit-item-dialog";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

const item: RoadmapCardData = {
  id: "item-1",
  title: "Improve onboarding",
  description: null,
  horizon: "NOW",
  sortOrder: 0,
  isPrivate: false,
  solutionId: "solution-1",
  keyResultId: "kr-1",
  opportunityId: "opp-1",
  experimentId: "experiment-1",
  feedbackId: "feedback-1",
  startDate: null,
  endDate: null,
  solution: { id: "solution-1", title: "Guided setup" },
  keyResult: {
    id: "kr-1",
    title: "Activation",
    current: 10,
    target: 50,
    unit: "%",
    cycleId: "cycle-1",
  },
  opportunity: { id: "opp-1", title: "Setup is confusing" },
  experiment: { id: "experiment-1", title: "Setup concierge" },
  feedback: { id: "feedback-1", title: "Setup feedback", type: "IDEA" },
  squad: null,
  launchChecklist: null,
  deliveryStatus: "NOT_STARTED",
};

const opportunities = [
  { id: "opp-1", title: "Setup is confusing" },
  { id: "opp-2", title: "Retention friction" },
];

function renderDialog(onSaved = vi.fn()) {
  render(
    <EditItemDialog
      item={item}
      open
      onOpenChange={vi.fn()}
      revalidatePathStr="/rbcodelabs/compass/roadmap"
      onSaved={onSaved}
      availableOpportunities={opportunities}
    />,
  );
  return onSaved;
}

async function chooseOpportunity(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Opportunity" }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("EditItemDialog opportunity link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateRoadmapItemMock.mockResolvedValue({
      ...item,
      startDate: null,
      endDate: null,
    });
  });

  afterEach(cleanup);

  it("shows the current opportunity as the preselected value", () => {
    renderDialog();

    expect(screen.getByRole("combobox", { name: "Opportunity" })).toHaveTextContent(
      "Setup is confusing",
    );
  });

  it("optimistically replaces the card opportunity after saving another workspace opportunity", async () => {
    const onSaved = renderDialog();
    updateRoadmapItemOpportunityMock.mockResolvedValue({
      opportunityId: "opp-2",
      opportunity: opportunities[1],
    });

    await chooseOpportunity("Retention friction");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateRoadmapItemOpportunityMock).toHaveBeenCalledWith(
        "item-1",
        "opp-2",
        "/rbcodelabs/compass/roadmap",
      );
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
        opportunityId: "opp-2",
        opportunity: opportunities[1],
        solution: item.solution,
        keyResult: item.keyResult,
        experiment: item.experiment,
        feedback: item.feedback,
      }));
    });
  });

  it("supports clearing the opportunity link with None", async () => {
    const onSaved = renderDialog();
    updateRoadmapItemOpportunityMock.mockResolvedValue({
      opportunityId: null,
      opportunity: null,
    });

    await chooseOpportunity("— None —");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateRoadmapItemOpportunityMock).toHaveBeenCalledWith(
        "item-1",
        null,
        "/rbcodelabs/compass/roadmap",
      );
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
        opportunityId: null,
        opportunity: null,
      }));
    });
  });
});
