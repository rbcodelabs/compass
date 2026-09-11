import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Roadmap dashboard workspace layout", () => {
  it("uses a roadmap-scoped responsive header and distinct content regions", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");
    const header = source("components/roadmap/roadmap-header.tsx");
    const timeline = source("components/roadmap/native-timeline/native-timeline.tsx");

    expect(page).toContain("<RoadmapHeader squads={squads} />");
    expect(timeline).toContain("<RoadmapHeader");
    expect(page).not.toContain("<WorkspacePage");
    expect(page).not.toContain("toolbar={");
    expect(page).not.toContain("Drag items between horizons");
    expect(page).not.toContain("See when items are planned");
    expect(page).not.toContain("md:p-8");
    expect(header).toContain('data-slot="workspace-header"');
    expect(header).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(header).toContain("md:grid-cols-[minmax(0,1fr)_auto_auto]");
    expect(header).toContain("row-start-2");
    expect(header).toContain("md:row-start-1");
    expect(page).toContain('data-slot="workspace-content"');
    expect(timeline).toContain('data-slot="workspace-content"');
    expect(timeline).toContain("min-h-0 min-w-0 flex-1 overflow-y-auto");
    expect(timeline).not.toContain("<TimelineToolbar");
  });

  it("lets the Roadmap board and columns consume the remaining desktop height without clipping mobile", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");
    const board = source("components/roadmap/roadmap-board.tsx");
    const column = source("components/roadmap/roadmap-column.tsx");

    expect(page).toContain("flex min-h-full min-w-0 flex-1 flex-col md:h-full md:min-h-0");
    expect(page).toContain('data-slot="workspace-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:overflow-hidden"');
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
