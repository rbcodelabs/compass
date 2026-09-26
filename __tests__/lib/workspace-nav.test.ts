import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getWorkspaceSwitchPath, TOP_LEVEL_SECTIONS } from "@/lib/workspace-nav";

describe("getWorkspaceSwitchPath", () => {
  it("drops a workspace-scoped entity ID when switching workspaces (the reported bug)", () => {
    // e.g. viewing an opportunity detail page in Workspace A, then switching to Workspace B
    const result = getWorkspaceSwitchPath(
      "/rbcodelabs/workspace-a/discovery/386a8512-88c6-4490-ac0a-2f18c5fdd215",
      "rbcodelabs",
      "workspace-a",
      "rbcodelabs",
      "workspace-b"
    );
    expect(result).toBe("/rbcodelabs/workspace-b/discovery");
  });

  it("preserves a top-level section with no entity ID", () => {
    const result = getWorkspaceSwitchPath(
      "/rbcodelabs/workspace-a/okrs",
      "rbcodelabs",
      "workspace-a",
      "rbcodelabs",
      "workspace-b"
    );
    expect(result).toBe("/rbcodelabs/workspace-b/okrs");
  });

  it("lands on the new workspace root when currently at the workspace root", () => {
    const result = getWorkspaceSwitchPath(
      "/rbcodelabs/workspace-a",
      "rbcodelabs",
      "workspace-a",
      "rbcodelabs",
      "workspace-b"
    );
    expect(result).toBe("/rbcodelabs/workspace-b");
  });

  it("drops entity IDs for docs, experiments, and OKR cycle detail routes", () => {
    expect(
      getWorkspaceSwitchPath(
        "/rbcodelabs/workspace-a/docs/some-doc-id",
        "rbcodelabs",
        "workspace-a",
        "rbcodelabs",
        "workspace-b"
      )
    ).toBe("/rbcodelabs/workspace-b/docs");

    expect(
      getWorkspaceSwitchPath(
        "/rbcodelabs/workspace-a/experiments/exp-id",
        "rbcodelabs",
        "workspace-a",
        "rbcodelabs",
        "workspace-b"
      )
    ).toBe("/rbcodelabs/workspace-b/experiments");

    expect(
      getWorkspaceSwitchPath(
        "/rbcodelabs/workspace-a/okrs/cycle-id",
        "rbcodelabs",
        "workspace-a",
        "rbcodelabs",
        "workspace-b"
      )
    ).toBe("/rbcodelabs/workspace-b/okrs");
  });

  it("falls back to the new workspace root for an unrecognized section", () => {
    const result = getWorkspaceSwitchPath(
      "/rbcodelabs/workspace-a/not-a-real-section/foo",
      "rbcodelabs",
      "workspace-a",
      "rbcodelabs",
      "workspace-b"
    );
    expect(result).toBe("/rbcodelabs/workspace-b");
  });

  it("falls back to the new workspace root when pathname doesn't match the current org/workspace prefix", () => {
    const result = getWorkspaceSwitchPath(
      "/some/other/path",
      "rbcodelabs",
      "workspace-a",
      "rbcodelabs",
      "workspace-b"
    );
    expect(result).toBe("/rbcodelabs/workspace-b");
  });
});

describe("getWorkspaceSwitchPath — every top-level section survives a switch", () => {
  const sw = (pathname: string) =>
    getWorkspaceSwitchPath(pathname, "o", "a", "o", "b");

  it.each(["tasks", "decisions", "canvas", "agent", "updates", "metrics"])(
    "keeps /%s when switching workspaces",
    (section) => {
      expect(sw(`/o/a/${section}`)).toBe(`/o/b/${section}`);
    }
  );

  it("drops the task ID but keeps /tasks", () => {
    expect(sw("/o/a/tasks/5239bd94-d0e6-43cc-9592-3f94c6b04723")).toBe(
      "/o/b/tasks"
    );
  });

  it("drops sub-routes like /decisions/new but keeps /decisions", () => {
    expect(sw("/o/a/decisions/new")).toBe("/o/b/decisions");
  });

  it("falls back to the workspace root from /reviews/<id>, which has no landing page", () => {
    expect(sw("/o/a/reviews/some-request-id")).toBe("/o/b");
  });
});

describe("TOP_LEVEL_SECTIONS drift guard", () => {
  it("matches every static top-level route under app/[orgSlug]/[workspaceSlug]/ that has a landing page", () => {
    const routeRoot = path.join(
      __dirname,
      "..",
      "..",
      "app",
      "[orgSlug]",
      "[workspaceSlug]"
    );
    const routeSections = fs
      .readdirSync(routeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Dynamic ([param]), private (_folder) and route-group ((group)) segments
      // are not addressable top-level sections.
      .filter((name) => !/^[[_(]/.test(name))
      // A section is only a safe landing target if it renders at its root.
      .filter((name) => fs.existsSync(path.join(routeRoot, name, "page.tsx")))
      .sort();

    expect([...TOP_LEVEL_SECTIONS].sort()).toEqual(routeSections);
  });
});
