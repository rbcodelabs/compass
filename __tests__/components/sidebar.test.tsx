// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

let pathname = "/rbcodelabs/compass/okrs";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/actions/auth-actions", () => ({
  signOutAction: vi.fn(),
}));

vi.mock("@/lib/meta-feedback-actions", () => ({
  sendCompassFeedback: vi.fn(),
}));

import { Sidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentRailProvider } from "@/components/agent/agent-rail-context";

const baseProps = {
  orgSlug: "rbcodelabs",
  workspaceSlug: "compass",
  workspaceName: "Compass",
  userName: "Rick Bowman",
  userEmail: "rick@rbcodelabs.com",
  workspaces: [
    { id: "ws-1", name: "Compass", slug: "compass", orgSlug: "rbcodelabs" },
  ],
};

function renderSidebar(isOrgAdmin: boolean, researchCaptureEnabled = true) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar {...baseProps} isOrgAdmin={isOrgAdmin} researchCaptureEnabled={researchCaptureEnabled} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.cookie = "sidebar_state=; max-age=0; path=/";
    document.cookie = "compass_panel_agent=; max-age=0; path=/";
    pathname = "/rbcodelabs/compass/okrs";
  });

  afterEach(() => {
    cleanup();
  });

  it("does not clutter primary nav with Settings, Org Settings, User Guide, or Send Feedback", () => {
    renderSidebar(true);

    const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
    // Primary sections stay in the main nav...
    expect(within(mainNav).getByText("OKRs")).toBeInTheDocument();
    expect(within(mainNav).getByText("Roadmap")).toBeInTheDocument();
    expect(within(mainNav).getByText("Docs")).toBeInTheDocument();
    // ...but the secondary items no longer render as standalone nav landmarks.
    expect(screen.queryByRole("navigation", { name: "Settings navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "User Guide navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Feedback navigation" })).not.toBeInTheDocument();
    // The menu is closed by default, so these items aren't in the document at all yet.
    expect(screen.queryByText("Org Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("User Guide")).not.toBeInTheDocument();
    expect(screen.queryByText("Send Feedback about Compass")).not.toBeInTheDocument();
  });

  it("surfaces Settings, Org Settings, User Guide, and Send Feedback inside the avatar dropdown for org admins", async () => {
    renderSidebar(true);

    const trigger = screen.getByText("Rick Bowman").closest("button");
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLButtonElement);

    expect(await screen.findByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/rbcodelabs/compass/settings"
    );
    expect(await screen.findByRole("link", { name: "Org Settings" })).toHaveAttribute(
      "href",
      "/rbcodelabs/settings"
    );
    expect(await screen.findByRole("link", { name: "User Guide" })).toHaveAttribute("href", "/help");
    expect(await screen.findByText("Send Feedback about Compass")).toBeInTheDocument();
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
  });

  /**
   * The account-wide `/settings/*` routes are only reachable from this menu —
   * they have no entry in the main nav and no workspace-scoped equivalent. A
   * passkey page nobody can navigate to is the same as no passkey page, and
   * that gap shipped once already: `/settings/passkeys` was built, deployed and
   * WebAuthn-verified while being unreachable from anywhere in the UI, because
   * every test drove it via a direct URL. Assert the links themselves, not just
   * the pages they point at.
   */
  it("links to both account-wide settings routes from the avatar dropdown", async () => {
    renderSidebar(false);

    const trigger = screen.getByText("Rick Bowman").closest("button");
    fireEvent.click(trigger as HTMLButtonElement);

    expect(await screen.findByRole("link", { name: "My agents" })).toHaveAttribute(
      "href",
      "/settings/agents"
    );
    expect(await screen.findByRole("link", { name: "Passkeys" })).toHaveAttribute(
      "href",
      "/settings/passkeys"
    );
  });

  it("hides Org Settings from the avatar dropdown for non-admins", async () => {
    renderSidebar(false);

    const trigger = screen.getByText("Rick Bowman").closest("button");
    fireEvent.click(trigger as HTMLButtonElement);

    expect(await screen.findByRole("link", { name: "User Guide" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Org Settings" })).not.toBeInTheDocument();
  });

  it("collapses to the icon rail and persists the preference", () => {
    renderSidebar(true);

    const sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
    expect(sidebar).toHaveAttribute("data-state", "expanded");

    fireEvent.click(screen.getAllByRole("button", { name: "Toggle Sidebar" })[0]);

    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(document.cookie).toContain("sidebar_state=false");
  });

  it("supports the shadcn Ctrl+B keyboard shortcut", () => {
    renderSidebar(true);

    const sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    expect(sidebar).toHaveAttribute("data-state", "collapsed");
  });

  it("keeps legacy Feedback navigation when research capture is gated off", () => {
    renderSidebar(true, false)
    const mainNav = screen.getByRole("navigation", { name: "Main navigation" })
    expect(within(mainNav).getByRole("link", { name: "Feedback" }))
      .toHaveAttribute("href", "/rbcodelabs/compass/feedback")
    expect(within(mainNav).queryByRole("link", { name: "Capture" })).not.toBeInTheDocument()
  })

  /**
   * The agent rail's toggle. It lives in this nav rather than as a trailing
   * action on the Agent row because `SidebarMenuAction` is hidden in icon mode,
   * which would hide the control from precisely the users who collapse the nav
   * to make room for the rail.
   */
  describe("agent panel toggle", () => {
    it("is absent outside a workspace, where there is no rail to toggle", () => {
      // The settings tree renders this sidebar with no AgentRailProvider.
      renderSidebar(true);
      expect(screen.queryByRole("button", { name: /agent panel/i })).not.toBeInTheDocument();
      // The Agent *link* is untouched either way — both surfaces are keepers.
      const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(within(mainNav).getByRole("link", { name: "Agent" })).toHaveAttribute(
        "href",
        "/rbcodelabs/compass/agent",
      );
    });

    it("toggles the rail without touching the nav's own collapsed state", () => {
      render(
        <TooltipProvider>
          <SidebarProvider>
            <AgentRailProvider>
              <Sidebar {...baseProps} isOrgAdmin researchCaptureEnabled />
            </AgentRailProvider>
          </SidebarProvider>
        </TooltipProvider>,
      );

      const sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
      const toggle = screen.getByRole("button", { name: "Agent panel" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(toggle);

      expect(screen.getByRole("button", { name: "Agent panel" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(document.cookie).toContain("compass_panel_agent=1");
      // "Don't touch nav at all": opening the rail must not collapse the nav
      // out from under the user.
      expect(sidebar).toHaveAttribute("data-state", "expanded");
    });

    it("is absent on the full-page Agent screen, so it cannot open a second live chat", () => {
      pathname = "/rbcodelabs/compass/agent";
      render(
        <TooltipProvider>
          <SidebarProvider>
            <AgentRailProvider initialPin={{ pinned: true, width: 448 }}>
              <Sidebar {...baseProps} isOrgAdmin researchCaptureEnabled />
            </AgentRailProvider>
          </SidebarProvider>
        </TooltipProvider>,
      );
      expect(screen.queryByRole("button", { name: /agent panel/i })).not.toBeInTheDocument();
      // The Agent link itself is still there — it is the page you are on.
      const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(within(mainNav).getByRole("link", { name: "Agent" })).toBeInTheDocument();
    });
  });
});
