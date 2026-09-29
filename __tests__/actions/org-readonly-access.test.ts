import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for updateMemberWorkspaceReadOnlyAccess
 * (app/[orgSlug]/[workspaceSlug]/settings/actions.ts).
 *
 * Deliberately exercises the real `resolveOrgAdmin` (lib/permissions.ts)
 * rather than mocking it away -- the whole point of this action is that it is
 * gated on ORG OWNER/ADMIN, a different and stricter check than the
 * workspace-admin gate (`resolveWorkspaceAdmin`) every other toggle on this
 * settings page uses. Mocking `resolveOrgAdmin` out would test nothing but
 * the plumbing; mocking only `@/lib/db` and `@/auth` (same pattern as
 * __tests__/lib/permissions.test.ts) proves the actual role check.
 */

const mockOrganizationMember = { findFirst: vi.fn() };
const mockOrganization = { update: vi.fn() };

const mockPrisma = {
  organizationMember: mockOrganizationMember,
  organization: mockOrganization,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { updateMemberWorkspaceReadOnlyAccess } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";

const mockAuth = vi.mocked(auth);
const mockRevalidatePath = vi.mocked(revalidatePath);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
  mockOrganization.update.mockResolvedValue({ id: "org-1" });
});

describe("updateMemberWorkspaceReadOnlyAccess", () => {
  it("lets an org ADMIN toggle the flag on", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" });

    await updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: true });

    expect(mockOrganization.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { memberWorkspaceReadOnlyAccess: true },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/core/settings");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("lets an org OWNER toggle the flag off", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "OWNER", organizationId: "org-1" });

    await updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: false });

    expect(mockOrganization.update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { memberWorkspaceReadOnlyAccess: false },
    });
  });

  it("rejects a workspace-only ADMIN who is not an org OWNER/ADMIN", async () => {
    // resolveOrgAdmin queries organizationMember, not workspaceMember -- a
    // workspace admin with no corresponding org-admin row simply has no
    // matching OrganizationMember row returned here, or one stored as MEMBER.
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });

    await expect(
      updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: true })
    ).rejects.toThrow("Forbidden: organization admin required");
    expect(mockOrganization.update).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a regular org MEMBER", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });

    await expect(
      updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: true })
    ).rejects.toThrow("Forbidden: organization admin required");
    expect(mockOrganization.update).not.toHaveBeenCalled();
  });

  it("rejects a caller with no OrganizationMember row at all", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);

    await expect(
      updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: true })
    ).rejects.toThrow("Organization not found");
    expect(mockOrganization.update).not.toHaveBeenCalled();
  });

  it("rejects a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(
      updateMemberWorkspaceReadOnlyAccess("acme", "core", { memberWorkspaceReadOnlyAccess: true })
    ).rejects.toThrow("Unauthorized");
    expect(mockOrganizationMember.findFirst).not.toHaveBeenCalled();
    expect(mockOrganization.update).not.toHaveBeenCalled();
  });
});
