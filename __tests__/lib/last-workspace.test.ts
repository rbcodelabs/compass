import { describe, expect, it } from "vitest";
import {
  LAST_WORKSPACE_COOKIE,
  lastWorkspaceCookieString,
  parseLastWorkspace,
  pickAnchorWorkspace,
  serializeLastWorkspace,
} from "@/lib/last-workspace";

const workspaces = [
  { id: "1", orgSlug: "acme", slug: "growth" },
  { id: "2", orgSlug: "acme", slug: "platform" },
  { id: "3", orgSlug: "globex", slug: "ops" },
];

describe("parseLastWorkspace", () => {
  it("reads org/workspace", () => {
    expect(parseLastWorkspace("acme/platform")).toEqual({ orgSlug: "acme", workspaceSlug: "platform" });
  });

  it("ignores missing and empty values", () => {
    expect(parseLastWorkspace(undefined)).toBeNull();
    expect(parseLastWorkspace(null)).toBeNull();
    expect(parseLastWorkspace("")).toBeNull();
  });

  it.each(["acme", "acme/", "/platform", "acme/platform/extra", "acme//platform", "a b/c", "acme/pla%tform", "../etc/passwd", "acme/<script>"])(
    "never throws and rejects malformed value %j",
    (value) => {
      expect(parseLastWorkspace(value)).toBeNull();
    },
  );

  it("rejects an over-long slug", () => {
    expect(parseLastWorkspace(`${"a".repeat(101)}/b`)).toBeNull();
  });
});

describe("serializeLastWorkspace and lastWorkspaceCookieString", () => {
  it("round-trips through parse", () => {
    expect(parseLastWorkspace(serializeLastWorkspace("acme", "growth"))).toEqual({ orgSlug: "acme", workspaceSlug: "growth" });
  });

  it("writes nothing when a slug is not cookie-safe", () => {
    expect(serializeLastWorkspace("acme", "grow th")).toBeNull();
    expect(lastWorkspaceCookieString("acme", "gro;wth")).toBeNull();
  });

  it("builds a site-wide, year-long, lax cookie, and adds secure on request", () => {
    expect(lastWorkspaceCookieString("acme", "growth")).toBe(`${LAST_WORKSPACE_COOKIE}=acme/growth; path=/; max-age=31536000; samesite=lax`);
    expect(lastWorkspaceCookieString("acme", "growth", true)).toMatch(/; secure$/);
  });
});

describe("pickAnchorWorkspace", () => {
  it("uses the remembered workspace when the person still belongs to it", () => {
    expect(pickAnchorWorkspace(workspaces, "acme/platform")?.id).toBe("2");
    expect(pickAnchorWorkspace(workspaces, "globex/ops")?.id).toBe("3");
  });

  it("falls back to the first workspace with no cookie", () => {
    expect(pickAnchorWorkspace(workspaces, undefined)?.id).toBe("1");
  });

  it("falls back for a workspace they do not belong to, so a forged cookie grants nothing", () => {
    expect(pickAnchorWorkspace(workspaces, "acme/secret")?.id).toBe("1");
    expect(pickAnchorWorkspace(workspaces, "initech/hr")?.id).toBe("1");
  });

  it("falls back for a malformed value", () => {
    expect(pickAnchorWorkspace(workspaces, "garbage")?.id).toBe("1");
  });

  it("limits organization settings to that organization's workspaces", () => {
    // Remembered workspace is in another organization: use the first one in this organization.
    expect(pickAnchorWorkspace(workspaces, "globex/ops", { orgSlug: "acme" })?.id).toBe("1");
    expect(pickAnchorWorkspace(workspaces, "acme/platform", { orgSlug: "acme" })?.id).toBe("2");
    expect(pickAnchorWorkspace(workspaces, "globex/ops", { orgSlug: "globex" })?.id).toBe("3");
  });

  it("returns undefined when there is nothing to anchor on", () => {
    expect(pickAnchorWorkspace([], "acme/growth")).toBeUndefined();
    expect(pickAnchorWorkspace(workspaces, "acme/growth", { orgSlug: "initech" })).toBeUndefined();
  });
});
