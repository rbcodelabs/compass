// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  SolutionSwimlaneBoard,
  makeColumnId,
  parseColumnId,
  classifyDragEnd,
  type SwimlaneOpportunity,
} from "@/components/discovery/solution-swimlane-board";

const openPanel = vi.fn();
const moveSolutionStatus = vi.fn();
const reorderSolution = vi.fn();
const addSolution = vi.fn();
const updateSolutionStatus = vi.fn();
const archiveSolution = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  moveSolutionStatus: (...args: unknown[]) => moveSolutionStatus(...args),
  reorderSolution: (...args: unknown[]) => reorderSolution(...args),
  addSolution: (...args: unknown[]) => addSolution(...args),
  updateSolutionStatus: (...args: unknown[]) => updateSolutionStatus(...args),
  archiveSolution: (...args: unknown[]) => archiveSolution(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Pure helpers: the riskiest logic in this board ───────────────────────────
// A single DndContext spans every lane, so column ids are namespaced
// `${opportunityId}::${status}` to keep identical status labels across lanes
// from colliding. classifyDragEnd is what decides, generically for *any*
// lane pair (not just one special-cased column), whether a drop persists a
// same-lane status change, a same-column reorder, or must revert because the
// destination belongs to a different Opportunity.

describe("makeColumnId / parseColumnId", () => {
  it("round-trips an opportunity id and status", () => {
    const id = makeColumnId("opp-1", "VALIDATED");
    expect(parseColumnId(id)).toEqual({ opportunityId: "opp-1", status: "VALIDATED" });
  });

  it("does not mistake a bare card id (no separator) for a column id", () => {
    expect(parseColumnId("sol-1")).toBeNull();
  });

  it("rejects a status that isn't a real SolutionStatus", () => {
    expect(parseColumnId("opp-1::NOT_A_STATUS")).toBeNull();
  });
});

describe("classifyDragEnd", () => {
  it("classifies a drop on the same column as a reorder", () => {
    const id = makeColumnId("opp-1", "IDEA");
    expect(classifyDragEnd(id, id)).toEqual({ kind: "reorder" });
  });

  it("classifies a same-lane, different-status drop as a move", () => {
    const source = makeColumnId("opp-1", "IDEA");
    const dest = makeColumnId("opp-1", "VALIDATED");
    expect(classifyDragEnd(source, dest)).toEqual({
      kind: "move",
      opportunityId: "opp-1",
      status: "VALIDATED",
    });
  });

  it("classifies a drop into a different lane as a cross-lane revert, even when the status label matches", () => {
    const source = makeColumnId("opp-1", "IDEA");
    const dest = makeColumnId("opp-2", "IDEA");
    expect(classifyDragEnd(source, dest)).toEqual({
      kind: "cross-lane-revert",
      sourceOpportunityId: "opp-1",
      sourceStatus: "IDEA",
    });
  });

  it("classifies a drop into a different lane's different status as a cross-lane revert too", () => {
    const source = makeColumnId("opp-1", "IDEA");
    const dest = makeColumnId("opp-2", "SHIPPED");
    expect(classifyDragEnd(source, dest)).toEqual({
      kind: "cross-lane-revert",
      sourceOpportunityId: "opp-1",
      sourceStatus: "IDEA",
    });
  });

  it("is generic across every lane pair, not just one special-cased lane", () => {
    const pairs: [string, string][] = [
      [makeColumnId("opp-a", "VALIDATED"), makeColumnId("opp-b", "VALIDATED")],
      [makeColumnId("opp-b", "SHIPPED"), makeColumnId("opp-c", "KILLED")],
      [makeColumnId("opp-z", "IN_DELIVERY"), makeColumnId("opp-y", "IN_DELIVERY")],
    ];
    for (const [source, dest] of pairs) {
      expect(classifyDragEnd(source, dest).kind).toBe("cross-lane-revert");
    }
  });
});

// ─── Rendering ────────────────────────────────────────────────────────────────

const opportunities: SwimlaneOpportunity[] = [
  {
    id: "opp-1",
    title: "Reduce onboarding drop-off",
    squad: { id: "squad-1", name: "Growth", color: "#ff6600" },
    solutions: [
      {
        id: "sol-1",
        title: "Guided setup wizard",
        description: "Step-by-step first-run flow",
        status: "IDEA",
        sortOrder: 0,
        _count: { assumptions: 2, evidence: 1 },
      },
      {
        id: "sol-2",
        title: "Inline tooltips",
        description: null,
        status: "VALIDATED",
        sortOrder: 0,
        _count: { assumptions: 1, evidence: 3 },
      },
    ],
  },
  {
    id: "opp-2",
    title: "Improve reporting accuracy",
    squad: null,
    solutions: [],
  },
];

function renderBoard(items: SwimlaneOpportunity[] = opportunities) {
  return render(
    <SolutionSwimlaneBoard
      opportunities={items}
      orgSlug="org"
      workspaceSlug="ws"
      workspaceId="ws-1"
    />
  );
}

describe("SolutionSwimlaneBoard rendering", () => {
  it("renders one lane per opportunity with the 5 solution-status columns", () => {
    renderBoard();

    expect(screen.getByText("Reduce onboarding drop-off")).toBeInTheDocument();
    expect(screen.getByText("Improve reporting accuracy")).toBeInTheDocument();

    // 5 statuses x 2 lanes = 10 column headings, which BoardColumn renders as
    // <h3>. Scoped to the heading role so this keeps asserting *columns* even
    // if a status label ever appears elsewhere in a lane again (cards no
    // longer carry a status badge — see the dedicated test below).
    expect(screen.getAllByRole("heading", { name: "Idea" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "Validated" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "In delivery" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "Shipped" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "Killed" })).toHaveLength(2);
  });

  it("places each solution in its own lane's matching status column, with evidence/assumption badges intact", () => {
    renderBoard();

    expect(screen.getByText("Guided setup wizard")).toBeInTheDocument();
    expect(screen.getByText("Inline tooltips")).toBeInTheDocument();
    expect(screen.getByText("2 assumptions")).toBeInTheDocument();
    expect(screen.getByText("1 assumption")).toBeInTheDocument();
  });

  it("omits each card's status badge — the column it sits in already says the status", () => {
    renderBoard();

    // The badge would be pure redundancy here and, being a shrink-0 sibling of
    // the title in EntityCard, it steals width and truncates the title. Same
    // reason OpportunityCard passes no status prop on the Opportunity board.
    const ideaCard = screen.getByText("Guided setup wizard").closest("[data-slot=card]");
    expect(ideaCard).not.toBeNull();
    expect(within(ideaCard as HTMLElement).queryByText("Idea")).not.toBeInTheDocument();

    const validatedCard = screen.getByText("Inline tooltips").closest("[data-slot=card]");
    expect(validatedCard).not.toBeNull();
    expect(within(validatedCard as HTMLElement).queryByText("Validated")).not.toBeInTheDocument();

    // Only the two column headings carry each label, never a third copy on a card.
    expect(screen.getAllByText("Idea")).toHaveLength(2);
    expect(screen.getAllByText("Validated")).toHaveLength(2);
  });

  it("shows the squad color dot on a lane whose opportunity has a squad, and omits it otherwise", () => {
    renderBoard();

    const growthLane = screen.getByText("Reduce onboarding drop-off").closest("button");
    expect(growthLane).not.toBeNull();
    expect(within(growthLane!).getByTitle("Growth")).toBeInTheDocument();

    const reportingLane = screen.getByText("Improve reporting accuracy").closest("button");
    expect(reportingLane).not.toBeNull();
    expect(within(reportingLane!).queryByTitle(/./)).not.toBeInTheDocument();
  });

  it("shows an empty lane with a working add-solution affordance for an opportunity with zero solutions", () => {
    renderBoard();

    const reportingLaneTrigger = screen.getByText("Improve reporting accuracy").closest("button");
    const lane = reportingLaneTrigger!.closest("[data-slot='collapsible']");
    expect(lane).not.toBeNull();
    expect(within(lane as HTMLElement).getByRole("button", { name: "Add Solution" })).toBeInTheDocument();
  });

  // Regression: lanes are flex children of a height-capped
  // `flex-col overflow-y-auto` container, so the default flex-shrink:1 let
  // flexbox squash each lane *below its content height*. The content then
  // spilled out of the lane box — column backgrounds painting outside the
  // lane's rounded border, column headers colliding with the lane header
  // above. Without shrink-0 the layout silently breaks again, and
  // overflow-hidden turns that spill into hard clipping instead.
  it("keeps each lane at its natural height and clips content to its rounded border", () => {
    renderBoard();

    const lane = screen
      .getByText("Reduce onboarding drop-off")
      .closest("button")!
      .closest("[data-slot='collapsible']");
    expect(lane).not.toBeNull();
    expect(lane).toHaveClass("shrink-0");
    expect(lane).toHaveClass("overflow-hidden");
  });

  it("collapsing a lane hides its columns", async () => {
    renderBoard();

    expect(screen.getAllByRole("heading", { name: "Idea" })).toHaveLength(2);

    const trigger = screen.getByText("Reduce onboarding drop-off").closest("button")!;
    fireEvent.click(trigger);

    await screen
      .findAllByRole("heading", { name: "Idea" })
      .then((matches) => expect(matches).toHaveLength(1));
    expect(screen.queryByText("Guided setup wizard")).not.toBeInTheDocument();
    // The other lane is untouched.
    expect(screen.getByText("Improve reporting accuracy")).toBeInTheDocument();
  });
});
