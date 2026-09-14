import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Feedback workspace layout", () => {
  it("keeps the approved controls in one title row without a byline or toolbar", () => {
    const page = source("app/[orgSlug]/[workspaceSlug]/feedback/page.tsx");
    const grid = source("components/feedback/feedback-grid.tsx");
    const dataGrid = source("components/data-grid/data-grid.tsx");
    const headerActions = source("components/feedback/feedback-header-actions.tsx");
    const createDialog = source("components/feedback/create-feedback-dialog.tsx");

    expect(page).toContain("<WorkspacePage");
    expect(page).toContain("actions={(");
    expect(page).not.toContain("toolbar={(");
    expect(page).not.toContain("description={");
    expect(page).not.toContain("PageHeader");
    expect(page).not.toContain('className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"');
    expect(grid).toContain('toolbarPortalId="feedback-header-toolbar"');
    expect(headerActions).toContain("const [toolbarHostReady, setToolbarHostReady] = useState(false)");
    expect(headerActions).toContain("window.requestAnimationFrame(() => setToolbarHostReady(true))");
    expect(headerActions).toContain("{toolbarHostReady && (");
    expect(headerActions).toContain('id="feedback-header-toolbar"');
    expect(headerActions).toContain("<CreateFeedbackDialog");
    expect(createDialog).toContain('aria-label={variant === "toolbar" ? "New Feedback" : undefined}');
    expect(createDialog).toContain('variant === "toolbar" && "hidden sm:inline"');
    expect(dataGrid).toContain("const observer = new MutationObserver(onStoreChange)");
    // The body-wide observer must stay guarded so it is never installed for a
    // toolbar that will not render. The guard now also covers `toolbar={false}`
    // callers, which have no toolbar to portal anywhere.
    expect(dataGrid).toContain("if (!toolbar || !toolbarPortalId) return () => {}");
    expect(dataGrid).toContain("return () => observer.disconnect()");
    expect(grid).toContain('placeholder: "Search feedback"');
    expect(grid).toContain('searchDisplay="popover"');
    expect(grid).toContain('allLabel: "All"');
    expect(grid).toContain('{ value: "IDEA", label: "Ideas" }');
    expect(grid).toContain('{ value: "BUG", label: "Bugs" }');
    expect(grid).toContain("onClearFilters={() => applyPatch({ status: null, type: null })}");
  });
});
