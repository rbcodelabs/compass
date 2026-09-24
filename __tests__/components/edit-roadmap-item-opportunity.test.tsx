// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { editRoadmapItemMock } = vi.hoisted(() => ({
  editRoadmapItemMock: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  editRoadmapItem: editRoadmapItemMock,
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
  updatedAt: "2026-09-07T00:00:00.000Z",
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

function renderDialog(
  onSaved = vi.fn(),
  onOpenChange = vi.fn(),
  availableOpportunities = opportunities,
) {
  render(
    <EditItemDialog
      item={item}
      workspaceId="ws-1"
      open
      onOpenChange={onOpenChange}
      revalidatePathStr="/rbcodelabs/compass/roadmap"
      onSaved={onSaved}
      availableOpportunities={availableOpportunities}
    />,
  );
  return { onSaved, onOpenChange };
}

async function chooseOpportunity(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Opportunity" }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("EditItemDialog opportunity link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editRoadmapItemMock.mockResolvedValue({
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

  it("submits Markdown through the dialog transaction and preserves the draft on failure", async () => {
    renderDialog();
    editRoadmapItemMock.mockRejectedValueOnce(new Error("Save failed"));
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    const source = screen.getByRole("textbox", { name: "Description Markdown source" });
    fireEvent.change(source, { target: { value: "## A plan\n\n- [ ] Preserve tasks" } });
    fireEvent.blur(source);
    expect(editRoadmapItemMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(source).toHaveValue("## A plan\n\n- [ ] Preserve tasks");
    expect(editRoadmapItemMock).toHaveBeenCalledWith("item-1", "ws-1", expect.objectContaining({ description: "## A plan\n\n- [ ] Preserve tasks" }));
  });

  it("submits null when the description is cleared", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description Markdown source" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(editRoadmapItemMock).toHaveBeenCalledWith("item-1", "ws-1", expect.objectContaining({ description: null })));
  });

  it("cancels without invoking the server action", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(editRoadmapItemMock).not.toHaveBeenCalled();
  });

  it("keeps an archived current opportunity visible when it is absent from the picker list", () => {
    renderDialog(vi.fn(), vi.fn(), [opportunities[1]]);

    expect(screen.getByRole("combobox", { name: "Opportunity" })).toHaveTextContent(
      "Setup is confusing",
    );
  });

  it("optimistically replaces the card opportunity after saving another workspace opportunity", async () => {
    const { onSaved } = renderDialog();
    editRoadmapItemMock.mockResolvedValue({
      ...item,
      opportunityId: "opp-2",
      opportunity: opportunities[1],
    });

    await chooseOpportunity("Retention friction");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(editRoadmapItemMock).toHaveBeenCalledWith(
        "item-1",
        "ws-1",
        expect.objectContaining({ opportunityId: "opp-2", title: "Improve onboarding" }),
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
    const { onSaved } = renderDialog();
    editRoadmapItemMock.mockResolvedValue({
      ...item,
      opportunityId: null,
      opportunity: null,
    });

    await chooseOpportunity("— None —");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(editRoadmapItemMock).toHaveBeenCalledWith(
        "item-1",
        "ws-1",
        expect.objectContaining({ opportunityId: null }),
      );
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
        opportunityId: null,
        opportunity: null,
      }));
    });
  });

  it("shows an inline error and keeps the dialog open when the atomic save fails", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(onSaved, onOpenChange);
    editRoadmapItemMock.mockRejectedValue(new Error("Opportunity not found or access denied"));

    await chooseOpportunity("Retention friction");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Opportunity not found or access denied",
    );
    expect(screen.getByRole("dialog", { name: "Edit roadmap item" })).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
