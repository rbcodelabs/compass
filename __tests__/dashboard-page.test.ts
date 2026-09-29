import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression test for the post-login landing page
 * (app/dashboard/page.tsx).
 *
 * Bug: a caller with zero `WorkspaceMember` rows was unconditionally sent to
 * /onboarding, even when an OrganizationMember row plus
 * Organization.memberWorkspaceReadOnlyAccess meant they actually had
 * somewhere real to go (see lib/workspace.ts's getUserWorkspaces()). Found by
 * a QA pass that logged in as a pure read-only org member and landed on
 * "Let's set up your organization" instead of a workspace.
 *
 * Deliberately reuses getUserWorkspaces() (mocked here) rather than
 * re-deriving the read-only fallback query -- this test proves the dashboard
 * page consults it and reacts to `isReadOnly` correctly, not the fallback
 * query shape itself (already covered by
 * __tests__/lib-workspace-orphaned-membership.test.ts).
 */

const mockWorkspaceMember = { findMany: vi.fn() };
const mockPrisma = { workspaceMember: mockWorkspaceMember };
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (authState.userId ? { user: { id: authState.userId } } : null),
}));

const mockGetUserWorkspaces = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace", () => ({ getUserWorkspaces: mockGetUserWorkspaces }));

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  })
);
vi.mock("next/navigation", () => ({ redirect }));

import DashboardPage from "@/app/dashboard/page";

beforeEach(() => {
  vi.clearAllMocks();
  authState.userId = "user-1";
  mockWorkspaceMember.findMany.mockResolvedValue([]);
  mockGetUserWorkspaces.mockResolvedValue([]);
});

describe("DashboardPage", () => {
  it("redirects to /login when signed out", async () => {
    authState.userId = null;
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockWorkspaceMember.findMany).not.toHaveBeenCalled();
  });

  it("redirects straight to the workspace for a single real membership (unchanged behavior)", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "ws-1", slug: "core", name: "Core", description: null, organization: { slug: "acme", name: "Acme" } } },
    ]);
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/acme/core/okrs");
    // The read-only fallback must not even be consulted when a real
    // membership already resolves the redirect.
    expect(mockGetUserWorkspaces).not.toHaveBeenCalled();
  });

  it("redirects to /onboarding when there is no real membership and no org grants read-only access", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([]);
    mockGetUserWorkspaces.mockResolvedValue([]);
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("BUG FIX: redirects a pure read-only org member into their workspace instead of onboarding", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([]);
    mockGetUserWorkspaces.mockResolvedValue([
      { id: "ws-9", name: "Nine", slug: "nine", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
    ]);
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/org-9/nine/okrs");
  });

  it("ignores a non-read-only entry from getUserWorkspaces when deciding the fallback (defense in depth)", async () => {
    // Should be unreachable in practice -- zero real WorkspaceMember rows
    // implies getUserWorkspaces has no member-only entries either -- but the
    // page filters on isReadOnly explicitly rather than trusting that.
    mockWorkspaceMember.findMany.mockResolvedValue([]);
    mockGetUserWorkspaces.mockResolvedValue([
      { id: "ws-1", name: "One", slug: "one", orgSlug: "org-1", orgName: "Org One", isReadOnly: false },
    ]);
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("does not redirect when there is more than one read-only workspace (renders a picker instead)", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([]);
    mockGetUserWorkspaces.mockResolvedValue([
      { id: "ws-9", name: "Nine", slug: "nine", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
      { id: "ws-10", name: "Ten", slug: "ten", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
    ]);
    const result = await DashboardPage();
    expect(redirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
