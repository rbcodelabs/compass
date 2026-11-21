import { describe, expect, it } from "vitest";
import { activeSettingsHref, buildSettingsNav } from "@/lib/settings-nav";

const ctx = { orgSlug: "acme", workspaceSlug: "growth", workspaceName: "Growth", isOrgAdmin: false };

describe("buildSettingsNav", () => {
  it("always offers the account group", () => {
    expect(buildSettingsNav({ orgSlug: null, workspaceSlug: null, isOrgAdmin: false }).map((g) => g.id)).toEqual(["account"]);
  });
  it("hides organization for non-admins and shows it for admins", () => {
    expect(buildSettingsNav(ctx).map((g) => g.id)).toEqual(["account", "workspace"]);
    expect(buildSettingsNav({ ...ctx, isOrgAdmin: true }).map((g) => g.id)).toEqual(["account", "workspace", "organization"]);
  });
  it("adds platform only for platform admins", () => {
    expect(buildSettingsNav({ ...ctx, isPlatformAdmin: true }).map((g) => g.id)).toContain("platform");
    expect(buildSettingsNav(ctx).map((g) => g.id)).not.toContain("platform");
  });
  it("links every group to the routes that exist today", () => {
    const hrefs = Object.fromEntries(
      buildSettingsNav({ ...ctx, isOrgAdmin: true, isPlatformAdmin: true }).map((g) => [g.id, g.items.map((i) => i.href)]),
    );
    expect(hrefs).toEqual({
      account: ["/settings/profile", "/settings/passkeys", "/settings/agents"],
      workspace: ["/acme/growth/settings", "/acme/growth/settings/modules"],
      organization: ["/acme/settings"],
      platform: ["/settings/admin/agent-snapshot"],
    });
  });
  it("marks admin-only items so they can be hidden or gated", () => {
    const groups = buildSettingsNav({ ...ctx, isOrgAdmin: true, isPlatformAdmin: true });
    const adminOnly = groups.flatMap((g) => g.items).filter((i) => i.adminOnly).map((i) => i.href);
    expect(adminOnly).toEqual(["/acme/settings", "/settings/admin/agent-snapshot"]);
  });
  it("offers account and organization, but no workspace, to an org admin who has no workspace", () => {
    const groups = buildSettingsNav({ orgSlug: "acme", workspaceSlug: null, isOrgAdmin: true });
    expect(groups.map((g) => g.id)).toEqual(["account", "organization"]);
  });
  it("never offers organization without an org slug, even if flagged admin", () => {
    expect(buildSettingsNav({ orgSlug: null, workspaceSlug: null, isOrgAdmin: true }).map((g) => g.id)).toEqual(["account"]);
  });
  it("shows the workspace and organization names as sublabels", () => {
    const groups = buildSettingsNav({ ...ctx, orgName: "Acme", isOrgAdmin: true });
    expect(groups.find((g) => g.id === "workspace")?.sublabel).toBe("Growth");
    expect(groups.find((g) => g.id === "organization")?.sublabel).toBe("Acme");
  });
});

describe("activeSettingsHref", () => {
  const groups = buildSettingsNav({ ...ctx, isOrgAdmin: true });
  it("prefers the longest matching href", () => {
    expect(activeSettingsHref(groups, "/acme/growth/settings/modules")).toBe("/acme/growth/settings/modules");
    expect(activeSettingsHref(groups, "/acme/growth/settings")).toBe("/acme/growth/settings");
  });
  it("does not confuse org and workspace settings", () => {
    expect(activeSettingsHref(groups, "/acme/settings")).toBe("/acme/settings");
  });
  it("returns null off the nav", () => {
    expect(activeSettingsHref(groups, "/dashboard")).toBeNull();
  });
  it("selects account routes and the platform route", () => {
    const all = buildSettingsNav({ ...ctx, isOrgAdmin: true, isPlatformAdmin: true });
    expect(activeSettingsHref(all, "/settings/profile")).toBe("/settings/profile");
    expect(activeSettingsHref(all, "/settings/agents")).toBe("/settings/agents");
    expect(activeSettingsHref(all, "/settings/admin/agent-snapshot")).toBe("/settings/admin/agent-snapshot");
  });
  it("matches sub-paths of an item but not a longer sibling name", () => {
    expect(activeSettingsHref(groups, "/settings/agents/anything")).toBe("/settings/agents");
    // "/settings/profile-old" is a different page, not a child of "/settings/profile".
    expect(activeSettingsHref(groups, "/settings/profile-old")).toBeNull();
  });
  it("selects nothing for a member who cannot see an item (no highlight for hidden pages)", () => {
    const memberGroups = buildSettingsNav(ctx);
    expect(activeSettingsHref(memberGroups, "/acme/settings")).toBeNull();
  });
});
