import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Roadmap faceted filters", () => {
  it("provides a reusable grouped filter menu with active count and clear all", () => {
    const menu = source("components/patterns/faceted-filter-menu.tsx");

    expect(menu).toContain("groups.map");
    expect(menu).toContain("DropdownMenuLabel");
    expect(menu).toContain("DropdownMenuRadioItem");
    expect(menu).toContain("option.color");
    expect(menu).toContain("activeCount");
    expect(menu).toContain("Clear all");
    expect(menu).toContain("onClearAll");
    expect(menu).not.toContain("groups.forEach");
  });

  it("adapts squads to the menu in the Roadmap header and preserves the squad query parameter", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");
    const adapter = source("components/roadmap/roadmap-header.tsx");

    expect(page).toContain("<RoadmapHeader squads={squads} />");
    expect(page).not.toContain("toolbar={");
    expect(page).not.toContain("SquadFilterBar");
    expect(adapter).toContain('set({ squad: value === "__all__" ? null : value })');
    expect(adapter).toContain('set({ squad: null })');
    expect(adapter).toContain('<DropdownMenuLabel>Squad</DropdownMenuLabel>');
    expect(adapter).toContain("Clear filters");
  });
});
