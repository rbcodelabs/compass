import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Experiments and Discovery dashboard workspace layouts", () => {
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
    expect(page).toContain(`<${filters} squads={squads} />`);
    expect(page).not.toContain("PageHeader");
    expect(page).not.toContain("SquadFilterBar");
    expect(page).not.toContain('className="overflow-x-auto min-w-0"');
  });

  it.each([
    ["experiment", "components/experiments/experiment-board.tsx", "experiment-board-track"],
    ["opportunity", "components/discovery/opportunity-board.tsx", "opportunity-board-track"],
  ])("makes the %s board the sole horizontal scroller with inset full-height columns", (_name, path, track) => {
    const board = source(path);

    expect(board).toContain("block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4");
    expect(board).toContain(`data-slot="${track}"`);
    expect(board).toContain("flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3");
    expect(board).toContain('className="min-w-[280px] flex-1 overflow-hidden md:h-full"');
    expect(board).toContain("md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto");
  });

  it("removes the Experiments responsive grid exception", () => {
    const board = source("components/experiments/experiment-board.tsx");

    expect(board).not.toContain("md:grid-cols-2");
    expect(board).not.toContain("xl:grid-cols-4");
    expect(board).not.toContain("md:overflow-visible");
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
