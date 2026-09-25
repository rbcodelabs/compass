// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const m = vi.hoisted(() => ({ setOpportunityFieldValue: vi.fn() }));

// Server actions reach for Prisma at import time — stub the whole module.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  setOpportunityFieldValue: m.setOpportunityFieldValue,
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));

import { OpportunityFieldBoard, type FieldBoardOpportunity } from "@/components/discovery/opportunity-field-board";

const field = {
  id: "moscow",
  name: "MoSCoW",
  options: [
    { label: "Must", value: "must", color: "#dc2626" },
    { label: "Should", value: "should" },
  ],
};

function opp(id: string, title: string, value: string | null): FieldBoardOpportunity {
  return { id, title, customerSegment: null, squad: null, _count: { solutions: 2, evidence: 1 }, value };
}

function renderBoard(opportunities = [opp("a", "Onboarding drop-off", null), opp("b", "Slow exports", "must")]) {
  return render(
    <OpportunityFieldBoard field={field} opportunities={opportunities} orgSlug="acme" workspaceSlug="core" workspaceId="ws-1" />
  );
}

const column = (id: string) => document.querySelector<HTMLElement>(`[data-column-id="${id}"]`)!;

async function chooseFromCardMenu(cardColumn: string, item: string) {
  fireEvent.click(within(column(cardColumn)).getAllByRole("button", { name: "Card actions" })[0]);
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  m.setOpportunityFieldValue.mockReset();
});
afterEach(cleanup);

describe("OpportunityFieldBoard", () => {
  it("renders Unspecified first, then options in definition order, with counts and card meta", () => {
    renderBoard();

    const columnIds = [...document.querySelectorAll("[data-column-id]")].map((el) => el.getAttribute("data-column-id"));
    expect(columnIds).toEqual(["unspecified", "option:must", "option:should"]);
    expect(column("unspecified")).toHaveAccessibleName("Unspecified, 1 opportunity");
    expect(column("option:must")).toHaveAccessibleName("Must, 1 opportunity");
    expect(column("option:should")).toHaveAccessibleName("Should, 0 opportunities");

    expect(within(column("unspecified")).getByText("Onboarding drop-off")).toBeInTheDocument();
    expect(within(column("option:must")).getByText("2 solutions · 1 evidence")).toBeInTheDocument();
    expect(screen.getByText("Drag between columns to change MoSCoW. Return to Unspecified to clear it.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Opportunity board grouped by MoSCoW" })).toBeInTheDocument();
    // Card sorting has no create footer and no reorder affordance.
    expect(screen.queryByRole("button", { name: /Add opportunity/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Drag to change MoSCoW" })).toHaveLength(2);
  });

  it("moves a card optimistically and persists the new option value", async () => {
    m.setOpportunityFieldValue.mockResolvedValue({ value: "should" });
    renderBoard();

    await chooseFromCardMenu("unspecified", "Move to Should");

    expect(within(column("option:should")).getByText("Onboarding drop-off")).toBeInTheDocument();
    expect(m.setOpportunityFieldValue).toHaveBeenCalledWith("a", "moscow", "should", "ws-1", "/acme/core/discovery");
    await waitFor(() => expect(screen.getByText("Moved Onboarding drop-off to Should.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the value when a card is returned to Unspecified", async () => {
    m.setOpportunityFieldValue.mockResolvedValue({ value: null });
    renderBoard();

    await chooseFromCardMenu("option:must", "Clear MoSCoW");

    expect(within(column("unspecified")).getByText("Slow exports")).toBeInTheDocument();
    expect(m.setOpportunityFieldValue).toHaveBeenCalledWith("b", "moscow", null, "ws-1", "/acme/core/discovery");
  });

  it("rolls the card back and announces an error when the save fails", async () => {
    let reject!: (error: Error) => void;
    m.setOpportunityFieldValue.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderBoard();

    await chooseFromCardMenu("option:must", "Move to Should");
    // Optimistic: already in Should while the request is in flight.
    expect(within(column("option:should")).getByText("Slow exports")).toBeInTheDocument();

    await act(async () => reject(new Error("Field not found in this workspace")));

    expect(within(column("option:must")).getByText("Slow exports")).toBeInTheDocument();
    expect(within(column("option:should")).queryByText("Slow exports")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't move \"Slow exports\" to Should. It is back in Must. Please try again."
    );
  });

  it("clears the error once a retried move succeeds", async () => {
    m.setOpportunityFieldValue.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ value: "should" });
    renderBoard();

    await chooseFromCardMenu("option:must", "Move to Should");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(within(column("option:must")).getByText("Slow exports")).toBeInTheDocument();

    await chooseFromCardMenu("option:must", "Move to Should");
    expect(within(column("option:should")).getByText("Slow exports")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
