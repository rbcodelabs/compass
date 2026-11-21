// @vitest-environment jsdom

// Regression test for Compass feedback item 4cb7d709-c580-44db-ac4b-e2edd1d4c9ed
// (roadmap aa50f95a-2dc9-4d18-bfb7-98da9385f1f4): /settings/agents ("My
// agents") has no layout.tsx of its own, so it falls through to the bare
// root app/layout.tsx and renders with NO Sidebar/BottomNav/MobileHeader
// chrome — unlike every other authenticated route. Org Settings
// (/[orgSlug]/settings) doesn't have this problem because
// app/[orgSlug]/settings/layout.tsx wraps children in that chrome, anchored
// on the caller's first workspace membership in that org for nav-link
// targets.
//
// app/settings/layout.tsx fixes this for the account-wide /settings/*
// routes the same way, anchoring on the caller's first workspace membership
// overall (across all orgs) — deterministic because getUserWorkspaces()
// already returns a stably-ordered list.

import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const getUserWorkspaces = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  })
);
const cookiesGet = vi.hoisted(() => vi.fn());
const orgMembership = vi.hoisted(() => vi.fn());
const requireWorkspaceContext = vi.hoisted(() => vi.fn());
const getSessionUser = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/workspace", () => ({ getUserWorkspaces }));
vi.mock("@/lib/workspace-context", () => ({ requireWorkspaceContext }));
vi.mock("@/lib/session", () => ({ getSessionUser }));
vi.mock("@/lib/db", () => ({
  default: () => ({
    organizationMember: { findFirst: orgMembership },
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookiesGet }) }));
vi.mock("next/navigation", () => ({
  redirect,
  usePathname: () => "/settings/agents",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/lib/meta-feedback-actions", () => ({ sendCompassFeedback: vi.fn() }));

import SettingsLayout from "@/app/settings/layout";
import WorkspaceSettingsLayout from "@/app/[orgSlug]/[workspaceSlug]/settings/layout";
import OrgSettingsLayout from "@/app/[orgSlug]/settings/layout";
import { LAST_WORKSPACE_COOKIE } from "@/lib/last-workspace";

const session = {
  user: { id: "user-1", name: "Casey Example", email: "casey@example.test" },
};

describe("SettingsLayout (account-wide /settings chrome)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue(session);
    orgMembership.mockResolvedValue({ role: "MEMBER" });
  });

  afterEach(cleanup);

  it("wraps children in the same Sidebar/BottomNav chrome as workspace routes, anchored on the first workspace membership overall", async () => {
    getUserWorkspaces.mockResolvedValue([
      { id: "ws-2", name: "B Workspace", slug: "b-ws", orgSlug: "acme", orgName: "Acme" },
      { id: "ws-1", name: "A Workspace", slug: "a-ws", orgSlug: "other-org", orgName: "Other Org" },
    ]);

    render(
      await SettingsLayout({
        children: <div data-testid="page-content">My agents content</div>,
      })
    );

    // The page's own content still renders, untouched.
    expect(screen.getByTestId("page-content")).toBeInTheDocument();

    // Sidebar nav is present, anchored on the FIRST workspace
    // getUserWorkspaces returned — "B Workspace" in "acme" — not re-sorted,
    // not defaulted to the second entry, and not filtered to a single org
    // (this route is account-wide, unlike [orgSlug]/settings).
    const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(mainNav.querySelector('a[href="/acme/b-ws/okrs"]')).toBeTruthy();
    expect(screen.getAllByText("B Workspace").length).toBeGreaterThan(0);

    // BottomNav (mobile chrome) renders real workspace-scoped links too.
    const bottomNav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(bottomNav).getByRole("link", { name: "OKRs" })).toHaveAttribute(
      "href",
      "/acme/b-ws/okrs"
    );
  });

  it("redirects to /login when there is no session", async () => {
    auth.mockResolvedValue(null);
    getUserWorkspaces.mockResolvedValue([]);

    await expect(SettingsLayout({ children: <div /> })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("renders children without crashing or forcing a redirect for a user with zero workspace memberships", async () => {
    getUserWorkspaces.mockResolvedValue([]);

    render(
      await SettingsLayout({
        children: <div data-testid="page-content">My agents content</div>,
      })
    );

    // The page's own content still renders — /settings/agents works for a
    // user with no workspaces (agents are owned by the user, not a
    // workspace) — and nothing throws or redirects for lack of an anchor.
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("scoped settings navigation", () => {
  const workspace = { id: "ws-growth", name: "Growth", slug: "growth", orgSlug: "acme", orgName: "Acme" };

  beforeEach(() => {
    vi.clearAllMocks();
    cookiesGet.mockReset();
    getUserWorkspaces.mockResolvedValue([workspace]);
    orgMembership.mockResolvedValue({ role: "OWNER" });
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "platform-admin@example.test");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it.each([
    { email: "platform-admin@example.test", showPlatform: true },
    { email: "casey@example.test", showPlatform: false },
  ])("workspace settings show platform navigation for $email: $showPlatform", async ({ email, showPlatform }) => {
    requireWorkspaceContext.mockResolvedValue({ workspace, isOrgAdmin: true, user: { ...session.user, email } });
    render(await WorkspaceSettingsLayout({
      children: <div />,
      params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "growth" }),
    }));

    const nav = within(screen.getByRole("navigation", { name: "Settings", exact: true }));
    const link = nav.queryByRole("link", { name: "Agent snapshot" });
    if (showPlatform) expect(link).toHaveAttribute("href", "/settings/admin/agent-snapshot");
    else expect(link).not.toBeInTheDocument();
  });

  it.each([
    { email: "platform-admin@example.test", showPlatform: true },
    { email: "casey@example.test", showPlatform: false },
  ])("organization settings show platform navigation for $email: $showPlatform", async ({ email, showPlatform }) => {
    getSessionUser.mockResolvedValue({ ...session.user, email });
    render(await OrgSettingsLayout({ children: <div />, params: Promise.resolve({ orgSlug: "acme" }) }));

    const nav = within(screen.getByRole("navigation", { name: "Settings", exact: true }));
    const link = nav.queryByRole("link", { name: "Agent snapshot" });
    if (showPlatform) expect(link).toHaveAttribute("href", "/settings/admin/agent-snapshot");
    else expect(link).not.toBeInTheDocument();
  });

  it("falls back within an organization after visiting a workspace in another organization", async () => {
    getSessionUser.mockResolvedValue(session.user);
    getUserWorkspaces.mockResolvedValue([
      workspace,
      { id: "ws-platform", name: "Platform", slug: "platform", orgSlug: "acme", orgName: "Acme" },
      { id: "ws-ops", name: "Operations", slug: "ops", orgSlug: "globex", orgName: "Globex" },
    ]);
    const params = Promise.resolve({ orgSlug: "acme" });

    cookiesGet.mockImplementation((name: string) => name === LAST_WORKSPACE_COOKIE ? { value: "acme/platform" } : undefined);
    render(await OrgSettingsLayout({ children: <div />, params }));
    expect(within(screen.getByRole("navigation", { name: "Settings", exact: true })).getByRole("link", { name: "Workspace settings" }))
      .toHaveAttribute("href", "/acme/platform/settings");
    cleanup();

    cookiesGet.mockImplementation((name: string) => name === LAST_WORKSPACE_COOKIE ? { value: "globex/ops" } : undefined);
    render(await OrgSettingsLayout({ children: <div />, params }));
    expect(within(screen.getByRole("navigation", { name: "Settings", exact: true })).getByRole("link", { name: "Workspace settings" }))
      .toHaveAttribute("href", "/acme/growth/settings");
  });
});
