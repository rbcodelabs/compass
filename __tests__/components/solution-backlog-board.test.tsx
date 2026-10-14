// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SolutionBacklogBoard, type SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  moveSolutionStatus: vi.fn(),
  updateSolutionStatus: vi.fn(),
  archiveSolution: vi.fn(),
}));

afterEach(() => cleanup());

function item(id: string, title: string, status: SolutionBacklogItem["status"], opp: string, score?: number): SolutionBacklogItem {
  return {
    id,
    title,
    description: null,
    status,
    sortOrder: 0,
    _count: { assumptions: 2, evidence: 1 },
    score: score === undefined ? null : { normalizedScore: score, modelVersion: 1, liveModelVersion: 1, stale: false },
    opportunity: { id: `opp-${opp}`, title: `Opportunity ${opp}`, squad: null },
  };
}

const solutions = [
  item("s1", "Wizard", "IDEA", "A"),
  item("s2", "Checklist", "IDEA", "B"),
  item("s3", "Templates", "SHIPPED", "B"),
];

function renderBoard(props: Partial<React.ComponentProps<typeof SolutionBacklogBoard>> = {}) {
  return render(
    <SolutionBacklogBoard solutions={solutions} orgSlug="org" workspaceSlug="ws" workspaceId="w1" {...props} />
  );
}

describe("SolutionBacklogBoard", () => {
  it("renders one column per status with solutions from different opportunities side by side", () => {
    renderBoard();
    const columns = document.querySelectorAll("[data-slot=solution-backlog-column]");
    expect([...columns].map((c) => c.getAttribute("data-status"))).toEqual([
      "IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED",
    ]);
    const idea = columns[0] as HTMLElement;
    expect(within(idea).getByText("Wizard")).toBeInTheDocument();
    expect(within(idea).getByText("Checklist")).toBeInTheDocument();
    expect(within(columns[3] as HTMLElement).getByText("Templates")).toBeInTheDocument();
  });

  it("links each card's parent opportunity to its discovery page", () => {
    renderBoard();
    expect(screen.getByRole("link", { name: "Opportunity A" })).toHaveAttribute("href", "/org/ws/discovery/opp-A");
  });

  it("shows evidence and assumption counts on each card", () => {
    renderBoard();
    expect(screen.getAllByText("2 assumptions")).toHaveLength(3);
  });

  it("keeps a fixed minimum column width inside a horizontally scrolling track", () => {
    renderBoard();
    expect(screen.getByRole("region", { name: "Solution backlog" })).toHaveClass("overflow-x-auto");
    expect(document.querySelector("[data-slot=solution-backlog-column]")).toHaveClass("min-w-[280px]", "flex-none");
  });

  it("orders a column by score when sorting by score with a scoring model", () => {
    const scored = [item("s1", "Low", "IDEA", "A", 10), item("s2", "High", "IDEA", "B", 90)];
    renderBoard({ solutions: scored, hasActiveScoringModel: true, sortByScore: true });
    const idea = document.querySelector("[data-slot=solution-backlog-column][data-status=IDEA]") as HTMLElement;
    const titles = within(idea).getAllByRole("button", { name: /^(Low|High)$/ }).map((b) => b.textContent);
    expect(titles).toEqual(["High", "Low"]);
  });

  it("shows an empty state when there are no solutions", () => {
    renderBoard({ solutions: [] });
    expect(screen.getByText("No solutions found")).toBeInTheDocument();
  });

  describe("group by", () => {
    const squadA = { id: "sq-a", name: "Alpha", color: "#111111" };
    const grouped = [
      { ...item("s1", "Wizard", "IDEA", "A"), opportunity: { id: "opp-A", title: "Opportunity A", squad: squadA }, fieldValue: "s" },
      { ...item("s2", "Checklist", "VALIDATED", "B"), fieldValue: null },
    ];
    const groupColumns = () => [...document.querySelectorAll("[data-slot=solution-backlog-column]")] as HTMLElement[];
    const heading = (column: HTMLElement) => column.querySelector("header h3")?.textContent;

    it("groups by squad: each squad plus No squad, cards keep their parent link", () => {
      renderBoard({ solutions: grouped, groupBy: "squad", squads: [squadA, { id: "sq-b", name: "Beta", color: "#222222" }] });
      expect(groupColumns().map(heading)).toEqual(["Alpha", "Beta", "No squad"]);
      expect(within(groupColumns()[0]).getByText("Wizard")).toBeInTheDocument();
      expect(within(groupColumns()[2]).getByText("Checklist")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "Opportunity B" })[0]).toHaveAttribute("href", "/org/ws/discovery/opp-B");
    });

    it("groups by parent opportunity", () => {
      renderBoard({ solutions: grouped, groupBy: "opportunity" });
      expect(groupColumns().map(heading)).toEqual(["Opportunity A", "Opportunity B"]);
    });

    it("groups by a solution field: Unspecified then each option", () => {
      renderBoard({
        solutions: grouped,
        groupBy: "field:f1",
        groupField: { id: "f1", name: "Effort", options: [{ value: "s", label: "Small" }, { value: "l", label: "Large" }] },
      });
      expect(groupColumns().map(heading)).toEqual(["Unspecified", "Small", "Large"]);
      expect(within(groupColumns()[1]).getByText("Wizard")).toBeInTheDocument();
      expect(within(groupColumns()[0]).getByText("Checklist")).toBeInTheDocument();
    });

    it("is read-only: no drag handles, a note explains it, columns keep min width and scroll", () => {
      renderBoard({ solutions: grouped, groupBy: "opportunity" });
      expect(screen.queryByLabelText("Drag to reorder")).not.toBeInTheDocument();
      expect(document.querySelector("[data-slot=solution-backlog-readonly-note]")).toHaveTextContent("read-only");
      expect(screen.getByRole("region", { name: /grouped by opportunity/i })).toHaveClass("overflow-x-auto");
      expect(groupColumns()[0]).toHaveClass("min-w-[280px]", "flex-none");
    });

    it("keeps drag handles on the default Status grouping", () => {
      renderBoard({ groupBy: "status" });
      expect(screen.getAllByLabelText("Drag to reorder")).toHaveLength(3);
    });

    it("shows the empty state when nothing matches", () => {
      renderBoard({ solutions: [], groupBy: "squad" });
      expect(screen.getByText("No solutions found")).toBeInTheDocument();
    });
  });
});
