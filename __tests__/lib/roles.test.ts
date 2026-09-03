/**
 * Unit tests for lib/roles.ts.
 *
 * These are the guard rails for the role columns. Both are bare VarChar(50)
 * with no database enum (Aurora DSQL has no enum support), so the only thing
 * keeping a stored role inside its TypeScript union is these two functions.
 * The table below includes every out-of-domain value that has actually been
 * written to production: "OWNER" (the MCP create_workspace tool copying an
 * org role into a workspace role) and lowercase "owner" (the admin
 * provisioning endpoint and setup-compass-workspace.ts).
 */
import { describe, it, expect } from "vitest";
import { canDecideReview, normalizeWorkspaceRole, normalizeOrgRole, isOrgAdminRole } from "@/lib/roles";

describe("normalizeWorkspaceRole", () => {
  const toAdmin = [
    "ADMIN",
    "admin",
    "Admin",
    "OWNER",
    "owner",
    "Owner",
    "  OWNER  ",
    " admin ",
    // trim() covers tabs and newlines, not just spaces
    String.fromCharCode(9) + "admin" + String.fromCharCode(10),
  ];
  for (const raw of toAdmin) {
    it("maps " + JSON.stringify(raw) + " to ADMIN", () => {
      expect(normalizeWorkspaceRole(raw)).toBe("ADMIN");
    });
  }

  const toMember: Array<string | null | undefined> = [
    "MEMBER",
    "member",
    "",
    "   ",
    "VIEWER",
    "OWNERS",
    null,
    undefined,
  ];
  for (const raw of toMember) {
    it("maps " + JSON.stringify(raw) + " to MEMBER", () => {
      expect(normalizeWorkspaceRole(raw)).toBe("MEMBER");
    });
  }
});

describe("normalizeOrgRole", () => {
  it("preserves OWNER, which is a real org role", () => {
    expect(normalizeOrgRole("OWNER")).toBe("OWNER");
    expect(normalizeOrgRole("owner")).toBe("OWNER");
    expect(normalizeOrgRole("  Owner ")).toBe("OWNER");
  });

  it("preserves ADMIN", () => {
    expect(normalizeOrgRole("ADMIN")).toBe("ADMIN");
    expect(normalizeOrgRole("admin")).toBe("ADMIN");
  });

  it("degrades everything unrecognized to MEMBER", () => {
    expect(normalizeOrgRole("MEMBER")).toBe("MEMBER");
    expect(normalizeOrgRole("member")).toBe("MEMBER");
    expect(normalizeOrgRole("")).toBe("MEMBER");
    expect(normalizeOrgRole("superuser")).toBe("MEMBER");
    expect(normalizeOrgRole(null)).toBe("MEMBER");
    expect(normalizeOrgRole(undefined)).toBe("MEMBER");
  });
});

describe("isOrgAdminRole", () => {
  it("is true for OWNER and ADMIN in any casing", () => {
    expect(isOrgAdminRole("OWNER")).toBe(true);
    expect(isOrgAdminRole("owner")).toBe(true);
    expect(isOrgAdminRole("ADMIN")).toBe(true);
    expect(isOrgAdminRole("admin")).toBe(true);
  });

  it("is false for members, unknown values, and missing values", () => {
    expect(isOrgAdminRole("MEMBER")).toBe(false);
    expect(isOrgAdminRole("whatever")).toBe(false);
    expect(isOrgAdminRole(null)).toBe(false);
    expect(isOrgAdminRole(undefined)).toBe(false);
  });
});

describe("review decision authority", () => {
  it.each(["ADMIN", "admin", "OWNER", "owner", "  Admin "])("shows decision controls for normalized workspace role %s", (role) => {
    expect(canDecideReview(role, null)).toBe(true);
  });

  it.each(["ADMIN", "admin", "OWNER", "owner"])("shows decision controls for normalized organization role %s", (role) => {
    expect(canDecideReview("MEMBER", role)).toBe(true);
  });

  it("does not show decision controls to ordinary members", () => {
    expect(canDecideReview("member", "member")).toBe(false);
  });
});
