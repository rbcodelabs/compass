import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrganizationMember = { findFirst: vi.fn() };
const mockWorkspace = { findFirst: vi.fn() };

const mockPrisma = {
  organizationMember: mockOrganizationMember,
  workspace: mockWorkspace,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { resolveOrgAdmin, resolveWorkspaceAdmin } from "@/lib/permissions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
});

// ─── resolveOrgAdmin ───────────────────────────────────────────────────────

describe("resolveOrgAdmin", () => {
  it("returns organizationId when caller is an OWNER", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "OWNER", organizationId: "org-1" });

    const result = await resolveOrgAdmin("org");

    expect(result.organizationId).toBe("org-1");
    expect(mockOrganizationMember.findFirst).toHaveBeenCalledWith({
      where: { organization: { slug: "org" }, userId: "user-1" },
      select: { role: true, organizationId: true },
    });
  });

  it("returns organizationId when caller is an ADMIN", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" });

    const result = await resolveOrgAdmin("org");

    expect(result.organizationId).toBe("org-1");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(resolveOrgAdmin("org")).rejects.toThrow("Unauthorized");
    expect(mockOrganizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("throws Organization not found when caller is not a member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);

    await expect(resolveOrgAdmin("org")).rejects.toThrow("Organization not found");
  });

  it("throws Forbidden when caller is a MEMBER (not org admin)", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });

    await expect(resolveOrgAdmin("org")).rejects.toThrow("Forbidden: organization admin required");
  });

  it("accepts a stored org role of lowercase owner", async () => {
    // The column is a bare VarChar and has held lowercase values; the check
    // goes through the same normalizer as the workspace gate.
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "owner", organizationId: "org-1" });

    const result = await resolveOrgAdmin("org");

    expect(result.organizationId).toBe("org-1");
  });

  it("accepts a stored org role of lowercase admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "admin", organizationId: "org-1" });

    await expect(resolveOrgAdmin("org")).resolves.toMatchObject({ organizationId: "org-1" });
  });

  it("still rejects an unrecognized org role", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "superuser", organizationId: "org-1" });

    await expect(resolveOrgAdmin("org")).rejects.toThrow("Forbidden: organization admin required");
  });
});

// ─── resolveWorkspaceAdmin ─────────────────────────────────────────────────

describe("resolveWorkspaceAdmin", () => {
  it("returns workspaceId/organizationId when caller is a workspace ADMIN", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "ADMIN" }],
    });

    const result = await resolveWorkspaceAdmin("org", "ws");

    expect(result.workspaceId).toBe("ws-1");
    expect(result.organizationId).toBe("org-1");
    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: {
        slug: "ws",
        organization: { slug: "org" },
        members: { some: { userId: "user-1" } },
      },
      select: {
        id: true,
        organizationId: true,
        members: {
          where: { userId: "user-1" },
          select: { role: true },
        },
        organization: {
          select: {
            members: {
              where: { userId: "user-1" },
              select: { role: true },
            },
          },
        },
      },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(resolveWorkspaceAdmin("org", "ws")).rejects.toThrow("Unauthorized");
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
  });

  it("throws Workspace not found when caller is not a member", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);

    await expect(resolveWorkspaceAdmin("org", "ws")).rejects.toThrow("Workspace not found");
  });

  it("throws Forbidden when caller is a workspace MEMBER (not admin)", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "MEMBER" }],
    });

    await expect(resolveWorkspaceAdmin("org", "ws")).rejects.toThrow("Forbidden: workspace admin required");
  });

  // ── normalization of out-of-domain stored roles ─────────────────────────

  it("accepts a stored workspace role of OWNER, which is not a WorkspaceRole", async () => {
    // Regression: the MCP create_workspace tool wrote the org role into
    // WorkspaceMember.role, so the workspace creator was stored as OWNER and
    // was then denied by the old strict inequality against ADMIN.
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "OWNER" }],
      organization: { members: [{ role: "MEMBER" }] },
    });

    const result = await resolveWorkspaceAdmin("org", "ws");

    expect(result.workspaceId).toBe("ws-1");
  });

  it("accepts a stored workspace role of lowercase owner", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "owner" }],
      organization: { members: [{ role: "MEMBER" }] },
    });

    await expect(resolveWorkspaceAdmin("org", "ws")).resolves.toMatchObject({ workspaceId: "ws-1" });
  });

  // ── org admins inherit workspace admin ──────────────────────────────────

  it("accepts a workspace MEMBER who is an OWNER of the organization", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "MEMBER" }],
      organization: { members: [{ role: "OWNER" }] },
    });

    const result = await resolveWorkspaceAdmin("org", "ws");

    expect(result.workspaceId).toBe("ws-1");
    expect(result.organizationId).toBe("org-1");
  });

  it("accepts a workspace MEMBER who is an ADMIN of the organization", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "MEMBER" }],
      organization: { members: [{ role: "ADMIN" }] },
    });

    await expect(resolveWorkspaceAdmin("org", "ws")).resolves.toMatchObject({ workspaceId: "ws-1" });
  });

  it("still rejects a workspace MEMBER who is only a MEMBER of the organization", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "MEMBER" }],
      organization: { members: [{ role: "MEMBER" }] },
    });

    await expect(resolveWorkspaceAdmin("org", "ws")).rejects.toThrow("Forbidden: workspace admin required");
  });

  it("still rejects when the caller has no org membership row at all", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role: "MEMBER" }],
      organization: { members: [] },
    });

    await expect(resolveWorkspaceAdmin("org", "ws")).rejects.toThrow("Forbidden: workspace admin required");
  });
});
