// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  updateSolutionStatus: vi.fn(),
  updateSolutionSortOrder: vi.fn(),
  moveSolutionToOpportunity: vi.fn(),
  addSolution: vi.fn(),
  deleteSolution: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/discovery",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider } from "@/components/panels/panel-context";
import {
  SolutionSwimlaneBoard,
  type SwimlaneOpportunity,
} from "@/components/discovery/solution-swimlane-board";
import { solutionSwimlaneKey } from "@/lib/discovery-filters";

function solution(id: string, title: string) {
  return {
    id,
    title,
    description: null,
    status: "IDEA" as const,
    sortOrder: 0,
    _count: { evidence: 0, assumptions: 0 },
  };
}

const tagged = solution("sol-tagged", "Auto-archive stale solutions");
const untagged = solution("sol-untagged", "Bulk re-link mode");

const lanes: SwimlaneOpportunity[] = [
  { id: "opp-1", title: "Teams cannot maintain a living OST", squad: null, solutions: [tagged, untagged] },
];
const laneFiltered: SwimlaneOpportunity[] = [
  { id: "opp-1", title: "Teams cannot maintain a living OST", squad: null, solutions: [tagged] },
];

/**
 * Mirrors how `discovery/page.tsx` mounts the swimlane board. The key must come
 * from the array actually rendered — deriving it from the pre-filter
 * opportunity query is the bug this pins, because a Solution-level tag filter
 * leaves the opportunity rows untouched by design.
 */
function Page({ opportunities }: { opportunities: SwimlaneOpportunity[] }) {
  return (
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <SolutionSwimlaneBoard
        key={solutionSwimlaneKey(opportunities)}
        opportunities={opportunities}
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        workspaceId="ws-1"
      />
    </PanelProvider>
  );
}

afterEach(() => cleanup());

describe("solutionSwimlaneKey", () => {
  it("changes when a lane's solutions are narrowed, even though its opportunity is unchanged", () => {
    expect(solutionSwimlaneKey(laneFiltered)).not.toBe(solutionSwimlaneKey(lanes));
  });

  it("is stable for the same rendered set", () => {
    expect(solutionSwimlaneKey(lanes)).toBe(solutionSwimlaneKey(lanes));
  });

  it("distinguishes a dropped lane from a dropped solution", () => {
    const keys = new Set([
      solutionSwimlaneKey(lanes),
      solutionSwimlaneKey(laneFiltered),
      solutionSwimlaneKey([]),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("SolutionSwimlaneBoard tag filter", () => {
  it("drops untagged solutions from a surviving lane when the filter narrows it", () => {
    const { rerender } = render(<Page opportunities={lanes} />);
    expect(screen.getByText("Auto-archive stale solutions")).toBeVisible();
    expect(screen.getByText("Bulk re-link mode")).toBeVisible();

    // What the server does on `?field=<solution field>&fieldValue=zz_alpha`:
    // the lane survives because it still has a match, but only the tagged
    // solution is handed down.
    rerender(<Page opportunities={laneFiltered} />);

    expect(screen.getByText("Auto-archive stale solutions")).toBeVisible();
    expect(screen.queryByText("Bulk re-link mode")).not.toBeInTheDocument();
  });

  it("restores the untagged solution when the filter is cleared", () => {
    const { rerender } = render(<Page opportunities={laneFiltered} />);
    expect(screen.queryByText("Bulk re-link mode")).not.toBeInTheDocument();

    rerender(<Page opportunities={lanes} />);

    expect(screen.getByText("Bulk re-link mode")).toBeVisible();
  });
});
