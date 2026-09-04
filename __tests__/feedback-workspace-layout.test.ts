import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Feedback workspace layout", () => {
  it("keeps every feedback control together in the workspace header toolbar", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/feedback/page.tsx");
    const grid = source("components/feedback/feedback-grid.tsx");
    const dataGrid = source("components/data-grid/data-grid.tsx");
    const headerActions = source("components/feedback/feedback-header-actions.tsx");

    expect(page).toContain("<WorkspacePage");
    expect(page).toContain("toolbar={(");
    expect(page).not.toContain("actions={(");
    expect(page).not.toContain("PageHeader");
    expect(page).not.toContain('className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"');
    expect(grid).toContain('toolbarPortalId="feedback-header-toolbar"');
    expect(headerActions).toContain('id="feedback-header-toolbar"');
    expect(headerActions).toContain("<CreateFeedbackDialog");
    expect(dataGrid).toContain("const clientReady = React.useSyncExternalStore(");
    expect(dataGrid).toContain("clientReady && toolbarPortalId");
    expect(grid).toContain('placeholder: "Search feedback"');
  });
});
