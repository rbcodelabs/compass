import { describe, it, expect } from "vitest";
import { getWorkspaceSwitchPath } from "@/lib/workspace-nav";

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
