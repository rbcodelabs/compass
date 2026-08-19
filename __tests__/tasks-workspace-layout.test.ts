import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Tasks dashboard workspace layout", () => {
  it("uses the compact workspace shell and puts filters beside the view toggle", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/tasks/page.tsx");

    expect(page).toContain("<WorkspacePage");
    expect(page).toContain("<TasksFilters squads={squads} members={members} />");
    expect(page).toContain("<TasksViewToggle view={view} />");
    expect(page).toContain('contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}');
    expect(page).not.toContain("PageHeader");
    expect(page).not.toContain("SquadFilterBar");
    expect(page).not.toContain("AssigneeFilterBar");
    expect(page).not.toContain("PriorityFilterBar");
    expect(page).not.toContain("Drag tasks between columns");
    expect(page).not.toContain('className="overflow-x-auto min-w-0"');
  });

  it("makes the board the sole horizontal scroller with inset track and independently scrolling columns", () => {
    const board = source("components/tasks/task-board.tsx");
    const column = source("components/tasks/task-column.tsx");

    expect(board).toContain("flex min-h-0 flex-1 flex-col");
    expect(board).toContain("md:overflow-hidden");
    expect(board).toContain('data-slot="task-board-track"');
    expect(board).toContain('className="flex h-full w-max min-w-full');
    expect(board).toContain("px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3");
    expect(board).toContain("scroll-px-3");
    expect(board).toContain("sm:scroll-px-4");
    expect(column).toContain('className="min-w-[280px] flex-1 overflow-hidden md:h-full"');
    expect(column).toContain("md:max-h-none");
    expect(column).toContain("md:overflow-y-auto");
  });
});
