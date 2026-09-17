// @vitest-environment jsdom

import { createElement as h } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

afterEach(cleanup);

// Both boards' cards reach for their workspace's server actions module at
// import time (Prisma, revalidatePath) and for the shared detail-panel
// context — stub both so the boards can mount in isolation.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({
  createExperiment: vi.fn(),
  startExperiment: vi.fn(),
  logResult: vi.fn(),
  concludeExperiment: vi.fn(),
  archiveExperiment: vi.fn(),
  moveExperiment: vi.fn(),
  reorderExperiment: vi.fn(),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createOpportunity: vi.fn(),
  updateOpportunityStatus: vi.fn(),
  archiveOpportunity: vi.fn(),
  moveOpportunity: vi.fn(),
  reorderOpportunity: vi.fn(),
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));

import { ExperimentBoard } from "@/components/experiments/experiment-board";
import { OpportunityBoard } from "@/components/discovery/opportunity-board";
import type { OpportunityStatus } from "@/lib/types";

function emptyOpportunitiesByStatus(): Record<OpportunityStatus, never[]> {
  return { EXPLORING: [], VALIDATING: [], PRIORITIZED: [], ACTIVE: [], ARCHIVED: [] };
}

describe("Experiments and Discovery board layout", () => {
  it.each([
    {
      name: "experiment",
      track: "experiment-board-track",
      boardLabel: "Experiment board",
      renderBoard: () =>
        render(
          h(ExperimentBoard, {
            experiments: [],
            orgSlug: "acme",
            workspaceSlug: "core",
            workspaceId: "ws-1",
          }),
        ),
    },
    {
      name: "opportunity",
      track: "opportunity-board-track",
      boardLabel: "Opportunity board",
      renderBoard: () =>
        render(
          h(OpportunityBoard, {
            opportunitiesByStatus: emptyOpportunitiesByStatus(),
            orgSlug: "acme",
            workspaceSlug: "core",
            workspaceId: "ws-1",
          }),
        ),
    },
  ])(
    "makes the $name board the sole horizontal scroller with inset full-height columns",
    ({ track, boardLabel, renderBoard }) => {
      const { container } = renderBoard();

      // The Board itself is the only horizontal scroller.
      const board = screen.getByRole("region", { name: boardLabel });
      expect(board.className).toContain(
        "block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4",
      );

      // Its track lays columns out edge-to-edge, full height.
      const trackEl = container.querySelector(`[data-slot="${track}"]`);
      expect(trackEl).not.toBeNull();
      expect(trackEl?.className).toContain(
        "flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3",
      );

      // Each column insets itself and fills the track height...
      const column = container.querySelector("section");
      expect(column?.className).toContain("min-w-[280px] flex-1 overflow-hidden md:h-full");

      // ...while only ITS OWN body (not the column) scrolls vertically.
      const body = column?.querySelector(":scope > div");
      expect(body?.className).toContain("md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto");
    },
  );

  it("removes the Experiment board's old responsive grid layout from the rendered DOM", () => {
    const { container } = render(
      h(ExperimentBoard, {
        experiments: [],
        orgSlug: "acme",
        workspaceSlug: "core",
        workspaceId: "ws-1",
      }),
    );

    // The board is a single horizontal scroller now, not a responsive grid
    // that reflowed into columns/rows at wider breakpoints.
    expect(container.innerHTML).not.toContain("md:grid-cols-2");
    expect(container.innerHTML).not.toContain("xl:grid-cols-4");
    expect(container.innerHTML).not.toContain("md:overflow-visible");
  });

  // TODO(test-debt): still a source-text check, not a real render — page.tsx Server Components (auth/prisma/notFound) have no test-execution precedent in this repo yet. See Compass test-suite audit 2026-09-12 and the readFileSync anti-pattern finding. Do not treat this as verified behavior.
  describe("Experiments and Discovery page shell (unverified source-text checks)", () => {
    it.each([
      ["Experiments", "app/[orgSlug]/[workspaceSlug]/experiments/page.tsx", "ExperimentsFilters"],
      ["Discovery", "app/[orgSlug]/[workspaceSlug]/discovery/page.tsx", "DiscoveryFilters"],
    ])("migrates %s to the compact full-bleed workspace shell", (_name, path, filters) => {
      const page = source(path);

      expect(page).toContain("<WorkspacePage");
      if (_name === "Discovery") {
        expect(page).toContain('contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}');
      } else {
        expect(page).toContain('contentClassName="p-0 sm:p-0 md:p-0"');
      }
      // Mounted with `squads`; extra props (e.g. custom-field filter facets) are allowed.
      expect(page).toMatch(new RegExp(`<${filters}\\b[^>]*\\bsquads=\\{squads\\}`, "s"));
      expect(page).not.toContain("PageHeader");
      expect(page).not.toContain("SquadFilterBar");
      expect(page).not.toContain('className="overflow-x-auto min-w-0"');
    });

    it("keeps Discovery archived work compact and separate from the board scroller", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/discovery/page.tsx");

      expect(page).toContain('view === "board" ? "shrink-0 px-3 pb-3 sm:px-4 sm:pb-4" : "mt-3 shrink-0"');
      expect(page.indexOf("<OpportunityBoard")).toBeLessThan(page.indexOf("<ArchivedSection"));
    });

    it("defaults unknown Discovery views to the board and gives the table normal page padding", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/discovery/page.tsx");

      expect(page).toContain('requestedView === "table" ? "table" : "board"');
      expect(page).toContain('contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}');
    });
  });
});
