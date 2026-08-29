/**
 * Unit tests for lib/normalize-member-roles.ts -- the three repair passes
 * shared by scripts/normalize-member-roles.ts and the
 * /api/admin/normalize-member-roles route.
 *
 * Prisma is a plain object here rather than a real client: the passes only
 * need findMany/update, and the point of the tests is the decision logic
 * (what is rewritten, what is skipped, what a dry run does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { normalizeMemberRoles } from "@/lib/normalize-member-roles";

const mockWorkspaceMember = { findMany: vi.fn(), update: vi.fn() };
const mockOrganizationMember = { findMany: vi.fn(), update: vi.fn() };
const mockOrganization = { findMany: vi.fn() };

// Structural stand-in for PrismaClient. The cast is confined to this one line
// so the module under test keeps its real parameter type.
const prisma = {
  workspaceMember: mockWorkspaceMember,
  organizationMember: mockOrganizationMember,
  organization: mockOrganization,
} as unknown as PrismaClient;

function wsRow(id: string, role: string, email = "a@example.com", slug = "compass") {
  return { id, role, user: { email }, workspace: { slug } };
}

function orgRow(id: string, role: string, email = "a@example.com", slug = "rbcodelabs") {
  return { id, role, user: { email }, organization: { slug } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkspaceMember.findMany.mockResolvedValue([]);
  mockOrganizationMember.findMany.mockResolvedValue([]);
  mockOrganization.findMany.mockResolvedValue([]);
});

describe("pass 1 — WorkspaceMember.role", () => {
  it("rewrites an OWNER workspace role to ADMIN", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([wsRow("wm-1", "OWNER", "rick@rbcodelabs.com")]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockWorkspaceMember.update).toHaveBeenCalledWith({
      where: { id: "wm-1" },
      data: { role: "ADMIN" },
    });
    expect(report.workspaceMembers.changed).toBe(1);
    expect(report.workspaceMembers.skipped).toBe(0);
    expect(report.workspaceMembers.changes).toEqual([
      { id: "wm-1", email: "rick@rbcodelabs.com", scope: "compass", from: "OWNER", to: "ADMIN" },
    ]);
  });

  it("rewrites a lowercase owner workspace role to ADMIN", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([wsRow("wm-2", "owner")]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockWorkspaceMember.update).toHaveBeenCalledWith({
      where: { id: "wm-2" },
      data: { role: "ADMIN" },
    });
    expect(report.workspaceMembers.changes[0].from).toBe("owner");
  });

  it("skips rows that already hold a valid value without writing", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([
      wsRow("wm-3", "ADMIN"),
      wsRow("wm-4", "MEMBER"),
    ]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
    expect(report.workspaceMembers.changed).toBe(0);
    expect(report.workspaceMembers.skipped).toBe(2);
    expect(report.totalChanged).toBe(0);
  });

  it("degrades an unrecognized value to MEMBER", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([wsRow("wm-5", "superuser")]);

    await normalizeMemberRoles(prisma);

    expect(mockWorkspaceMember.update).toHaveBeenCalledWith({
      where: { id: "wm-5" },
      data: { role: "MEMBER" },
    });
  });
});

describe("pass 2 — OrganizationMember.role", () => {
  it("rewrites a lowercase owner org role to OWNER", async () => {
    mockOrganizationMember.findMany.mockResolvedValue([orgRow("om-1", "owner")]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).toHaveBeenCalledWith({
      where: { id: "om-1" },
      data: { role: "OWNER" },
    });
    expect(report.organizationMembers.changes[0].to).toBe("OWNER");
  });

  it("keeps a valid OWNER org role untouched", async () => {
    mockOrganizationMember.findMany.mockResolvedValue([orgRow("om-2", "OWNER")]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).not.toHaveBeenCalled();
    expect(report.organizationMembers.skipped).toBe(1);
  });
});
describe("pass 3 — organization owner backfill", () => {
  function org(slug: string, members: Array<{ id: string; role: string; email?: string }>) {
    return {
      id: "org-" + slug,
      slug,
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        user: { email: m.email ?? m.id + "@example.com" },
      })),
    };
  }

  it("leaves an org that already has an OWNER alone", async () => {
    mockOrganization.findMany.mockResolvedValue([
      org("rbcodelabs", [{ id: "m-1", role: "OWNER" }, { id: "m-2", role: "ADMIN" }]),
    ]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).not.toHaveBeenCalled();
    expect(report.organizationOwners.alreadyOwned).toBe(1);
    expect(report.organizationOwners.promoted).toBe(0);
  });

  it("treats a lowercase owner as an existing OWNER", async () => {
    // Pass 2 has not been applied yet during a dry run, so the check has to go
    // through the normalizer or a dry run would disagree with a live run.
    mockOrganization.findMany.mockResolvedValue([org("test-org", [{ id: "m-1", role: "owner" }])]);

    const report = await normalizeMemberRoles(prisma);

    expect(report.organizationOwners.alreadyOwned).toBe(1);
    expect(report.organizationOwners.promoted).toBe(0);
  });

  it("promotes the earliest member, preferring one who is already an ADMIN", async () => {
    // findMany is ordered by createdAt asc, so index order is creation order.
    mockOrganization.findMany.mockResolvedValue([
      org("acme", [
        { id: "m-1", role: "MEMBER", email: "first@example.com" },
        { id: "m-2", role: "ADMIN", email: "second@example.com" },
        { id: "m-3", role: "ADMIN", email: "third@example.com" },
      ]),
    ]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).toHaveBeenCalledWith({
      where: { id: "m-2" },
      data: { role: "OWNER" },
    });
    expect(report.organizationOwners.promoted).toBe(1);
    expect(report.organizationOwners.entries).toEqual([
      {
        kind: "promoted",
        id: "m-2",
        email: "second@example.com",
        orgSlug: "acme",
        from: "ADMIN",
        to: "OWNER",
      },
    ]);
  });

  it("falls back to the earliest member when nobody is an ADMIN", async () => {
    mockOrganization.findMany.mockResolvedValue([
      org("acme", [
        { id: "m-1", role: "MEMBER" },
        { id: "m-2", role: "MEMBER" },
      ]),
    ]);

    await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: { role: "OWNER" },
    });
  });

  it("skips an org with no members instead of crashing", async () => {
    mockOrganization.findMany.mockResolvedValue([org("empty", [])]);

    const report = await normalizeMemberRoles(prisma);

    expect(mockOrganizationMember.update).not.toHaveBeenCalled();
    expect(report.organizationOwners.emptySkipped).toBe(1);
    expect(report.organizationOwners.promoted).toBe(0);
    expect(report.organizationOwners.entries).toEqual([
      { kind: "skipped-empty", orgSlug: "empty" },
    ]);
  });
});

describe("dry run", () => {
  it("reports the same change set as a live run but writes nothing", async () => {
    const wsRows = [wsRow("wm-1", "OWNER", "rick@rbcodelabs.com")];
    const orgRows = [orgRow("om-1", "owner")];
    const orgs = [
      {
        id: "org-1",
        slug: "acme",
        members: [{ id: "m-1", role: "ADMIN", user: { email: "a@example.com" } }],
      },
    ];

    mockWorkspaceMember.findMany.mockResolvedValue(wsRows);
    mockOrganizationMember.findMany.mockResolvedValue(orgRows);
    mockOrganization.findMany.mockResolvedValue(orgs);
    const dry = await normalizeMemberRoles(prisma, { dryRun: true });

    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
    expect(mockOrganizationMember.update).not.toHaveBeenCalled();
    expect(dry.dryRun).toBe(true);

    vi.clearAllMocks();
    mockWorkspaceMember.findMany.mockResolvedValue(wsRows);
    mockOrganizationMember.findMany.mockResolvedValue(orgRows);
    mockOrganization.findMany.mockResolvedValue(orgs);
    const live = await normalizeMemberRoles(prisma, { dryRun: false });

    expect(mockWorkspaceMember.update).toHaveBeenCalledTimes(1);
    expect(mockOrganizationMember.update).toHaveBeenCalledTimes(2);

    // Same decisions, only the dryRun flag differs.
    expect({ ...dry, dryRun: false }).toEqual(live);
    expect(dry.totalChanged).toBe(3);
  });

  it("defaults to writing when no options are passed", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([wsRow("wm-1", "OWNER")]);

    const report = await normalizeMemberRoles(prisma);

    expect(report.dryRun).toBe(false);
    expect(mockWorkspaceMember.update).toHaveBeenCalled();
  });
});
