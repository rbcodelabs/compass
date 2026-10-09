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

const authState = vi.hoisted(() => ({
  userId: null as string | null,
  user: null as { id: string; name?: string; email?: string } | null,
}));
vi.mock("@/auth", () => ({
  auth: async () =>
    authState.userId ? { user: authState.user ?? { id: authState.userId } } : null,
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

// The page wraps the gallery in a theme wrapper; unwrap to the gallery element.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gallery = async () => ((await DashboardPage()) as any).props.children as { props: Record<string, any> };

beforeEach(() => {
  vi.clearAllMocks();
  authState.userId = "user-1";
  authState.user = null;
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

  it("hands the gallery a flagged read-only list with the read-only notice on", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([]);
    mockGetUserWorkspaces.mockResolvedValue([
      { id: "ws-9", name: "Nine", slug: "nine", orgSlug: "org-9", orgName: "Org Nine", description: "d", memberCount: 4, isReadOnly: true },
      { id: "ws-10", name: "Ten", slug: "ten", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
    ]);
    const result = await gallery();
    expect(result.props.readOnlyNotice).toBe(true);
    expect(result.props.workspaces).toEqual([
      expect.objectContaining({ slug: "nine", description: "d", memberCount: 4, isReadOnly: true }),
      expect.objectContaining({ slug: "ten", isReadOnly: true }),
    ]);
  });

  it("maps multiple real memberships into gallery workspaces, with member counts and the session user", async () => {
    authState.user = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" };
    mockWorkspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "ws-1", slug: "core", name: "Core", description: "Main", _count: { members: 7 }, organization: { slug: "acme", name: "Acme" } } },
      // No `_count` -- must not throw.
      { workspace: { id: "ws-2", slug: "edge", name: "Edge", description: null, organization: { slug: "acme", name: "Acme" } } },
    ]);
    const result = await gallery();
    expect(redirect).not.toHaveBeenCalled();
    expect(result.props.userName).toBe("Ada Lovelace");
    expect(result.props.userEmail).toBe("ada@example.com");
    expect(result.props.readOnlyNotice).toBeUndefined();
    expect(result.props.workspaces).toEqual([
      { id: "ws-1", name: "Core", slug: "core", orgSlug: "acme", orgName: "Acme", description: "Main", memberCount: 7 },
      { id: "ws-2", name: "Edge", slug: "edge", orgSlug: "acme", orgName: "Acme", description: null, memberCount: undefined },
    ]);
  });

  it("falls back to the email, then a neutral name, when the session has no display name", async () => {
    authState.user = { id: "user-1", email: "ada@example.com" };
    mockWorkspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "a", slug: "a", name: "A", description: null, organization: { slug: "o", name: "O" } } },
      { workspace: { id: "b", slug: "b", name: "B", description: null, organization: { slug: "o", name: "O" } } },
    ]);
    expect((await gallery()).props.userName).toBe("ada@example.com");
    authState.user = { id: "user-1" };
    expect((await gallery()).props.userName).toBe("there");
  });
});
