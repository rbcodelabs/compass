// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import "@testing-library/jest-dom/vitest";

import { SolutionCard, type SolutionCardData } from "@/components/discovery/solution-card";

const openPanel = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  updateSolutionStatus: vi.fn(),
  archiveSolution: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseSolution: SolutionCardData = {
  id: "sol-1",
  title: "Guided setup wizard",
  description: "Step-by-step first-run flow",
  status: "IDEA",
  sortOrder: 0,
  _count: { assumptions: 2, evidence: 1 },
};

function renderCard(solution: SolutionCardData = baseSolution, showStatus?: boolean) {
  return render(
    <DndContext>
      <SolutionCard solution={solution} revalidatePathStr="/org/ws/discovery" showStatus={showStatus} />
    </DndContext>
  );
}

function cardFor(title: string) {
  const card = screen.getByText(title).closest("[data-slot=card]");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
// The badge is the only status signal in the Opportunity panel's flat
// SolutionsList, so it stays on by default. On a board whose columns *are*
// statuses it's pure redundancy that steals width from the title (the same
// reason OpportunityCard passes no status prop at all), so callers there opt
// out — see solution-swimlane-board.tsx.

describe("SolutionCard status badge", () => {
  it("renders the status badge by default, so the panel's flat list keeps today's behavior", () => {
    renderCard();
    expect(within(cardFor("Guided setup wizard")).getByText("Idea")).toBeInTheDocument();
  });

  it("renders the status badge when showStatus is explicitly true", () => {
    renderCard(baseSolution, true);
    expect(within(cardFor("Guided setup wizard")).getByText("Idea")).toBeInTheDocument();
  });

  it("omits the status badge when showStatus is false", () => {
    renderCard(baseSolution, false);
    expect(within(cardFor("Guided setup wizard")).queryByText("Idea")).not.toBeInTheDocument();
  });

  it("keeps the card menu's non-drag 'Move to <status>' actions even with the badge hidden", () => {
    renderCard(baseSolution, false);
    // The menu trigger must still be present — hiding the badge must not
    // remove the only non-drag way to change a solution's status.
    expect(within(cardFor("Guided setup wizard")).getByRole("button", { name: "Card actions" })).toBeInTheDocument();
  });
});

// ─── Metadata chips ───────────────────────────────────────────────────────────
// EvidenceBadge already returns null at 0 ("Renders nothing when there is no
// evidence, so callers can render unconditionally"). The assumptions chip now
// follows the same convention, and when both are empty the whole metadata row
// is suppressed so the card doesn't keep paying EntityCard's mt-3 gap for a
// blank row.

describe("SolutionCard metadata chips", () => {
  it("renders both chips when the counts are non-zero", () => {
    renderCard({ ...baseSolution, _count: { assumptions: 2, evidence: 1 } });
    const card = cardFor("Guided setup wizard");
    expect(within(card).getByText("2 assumptions")).toBeInTheDocument();
    expect(within(card).getByText("Backed by 1 signal")).toBeInTheDocument();
    expect(card.querySelector("[data-slot=solution-card-meta]")).not.toBeNull();
  });

  it("uses the singular label for exactly one assumption", () => {
    renderCard({ ...baseSolution, _count: { assumptions: 1, evidence: 0 } });
    expect(within(cardFor("Guided setup wizard")).getByText("1 assumption")).toBeInTheDocument();
  });

  it("hides the assumptions chip when the count is zero, keeping the evidence chip", () => {
    renderCard({ ...baseSolution, _count: { assumptions: 0, evidence: 3 } });
    const card = cardFor("Guided setup wizard");
    expect(within(card).queryByText("0 assumptions")).not.toBeInTheDocument();
    expect(within(card).getByText("Backed by 3 signals")).toBeInTheDocument();
    // Row still exists — the evidence chip is in it.
    expect(card.querySelector("[data-slot=solution-card-meta]")).not.toBeNull();
  });

  it("renders no metadata row at all when both counts are zero, so the card gets tighter", () => {
    renderCard({ ...baseSolution, _count: { assumptions: 0, evidence: 0 } });
    const card = cardFor("Guided setup wizard");
    expect(within(card).queryByText("0 assumptions")).not.toBeInTheDocument();
    expect(within(card).queryByText(/Backed by/)).not.toBeInTheDocument();
    // Not merely empty — absent, so EntityCard's mt-3 children wrapper is
    // never rendered and there's no blank gap under the title.
    expect(card.querySelector("[data-slot=solution-card-meta]")).toBeNull();
  });

  it("still renders the title and description when there is no metadata", () => {
    renderCard({ ...baseSolution, _count: { assumptions: 0, evidence: 0 } });
    const card = cardFor("Guided setup wizard");
    expect(within(card).getByText("Step-by-step first-run flow")).toBeInTheDocument();
  });
});
