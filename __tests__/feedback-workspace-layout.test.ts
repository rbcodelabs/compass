import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Feedback workspace layout", () => {
  it("uses the compact workspace shell with filters and creation in the header", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/feedback/page.tsx");
    const grid = source("components/feedback/feedback-grid.tsx");

    expect(page).toContain("<WorkspacePage");
    expect(page).toContain("<FeedbackHeaderActions");
    expect(page).not.toContain("PageHeader");
    expect(page).not.toContain('className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"');
    expect(grid).not.toContain("toolbarActions=");
    expect(grid).not.toContain("filters={filters}");
    expect(grid).toContain('placeholder: "Search feedback"');
  });
});
