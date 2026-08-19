import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Roadmap dashboard workspace layout", () => {
  it("uses the reusable compact workspace shell with distinct header and content regions", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");
    const shell = source("components/patterns/workspace-page.tsx");

    expect(page).toContain("<WorkspacePage");
    expect(page).not.toContain("toolbar={");
    expect(page).not.toContain("Drag items between horizons");
    expect(page).not.toContain("See when items are planned");
    expect(page).not.toContain("md:p-8");
    expect(shell).toContain('data-slot="workspace-header"');
    expect(shell).toContain('data-slot="workspace-toolbar"');
    expect(shell).toContain('data-slot="workspace-content"');
    expect(shell).toContain("min-h-0 flex-1");
  });

  it("lets the Roadmap board and columns consume the remaining desktop height without clipping mobile", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");
    const board = source("components/roadmap/roadmap-board.tsx");
    const column = source("components/roadmap/roadmap-column.tsx");

    expect(page).toContain('contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}');
    expect(page).not.toContain('className="flex min-h-0 flex-1 flex-col overflow-x-auto"');
    expect(board).toContain("flex min-h-0 flex-1 flex-col");
    expect(board).toContain("md:overflow-hidden");
    expect(board).toContain('data-slot="roadmap-board-track"');
    expect(board).toContain('className="flex h-full w-max min-w-full');
    expect(board).toContain("px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3");
    expect(board).toContain("scroll-px-3");
    expect(board).toContain("sm:scroll-px-4");
    expect(board).not.toContain("overflow-x-auto px-3");
    expect(column).toContain("md:h-full");
    expect(column).toContain('className="min-w-[280px] flex-1 overflow-hidden md:h-full"');
    expect(column).toContain("md:max-h-none");
    expect(column).toContain("md:overflow-y-auto");
  });
});
