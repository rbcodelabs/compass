// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/rbcodelabs/compass/okrs",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/actions/auth-actions", () => ({
  signOutAction: vi.fn(),
}));

vi.mock("@/lib/meta-feedback-actions", () => ({
  sendCompassFeedback: vi.fn(),
}));

import { Sidebar } from "@/components/sidebar";

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

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not clutter primary nav with Settings, Org Settings, Help, or Send Feedback", () => {
    render(<Sidebar {...baseProps} isOrgAdmin />);

    const mainNav = screen.getByRole("navigation", { name: "Main navigation" });
    // Primary sections stay in the main nav...
    expect(within(mainNav).getByText("OKRs")).toBeInTheDocument();
    expect(within(mainNav).getByText("Roadmap")).toBeInTheDocument();
    // ...but the secondary items no longer render as standalone nav landmarks.
    expect(screen.queryByRole("navigation", { name: "Settings navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Help navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Feedback navigation" })).not.toBeInTheDocument();
    // The menu is closed by default, so these items aren't in the document at all yet.
    expect(screen.queryByText("Org Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Help")).not.toBeInTheDocument();
    expect(screen.queryByText("Send Feedback about Compass")).not.toBeInTheDocument();
  });

  it("surfaces Settings, Org Settings, Help, and Send Feedback inside the avatar dropdown for org admins", async () => {
    render(<Sidebar {...baseProps} isOrgAdmin />);

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
    expect(await screen.findByRole("link", { name: "Help" })).toHaveAttribute("href", "/help");
    expect(await screen.findByText("Send Feedback about Compass")).toBeInTheDocument();
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
  });

  it("hides Org Settings from the avatar dropdown for non-admins", async () => {
    render(<Sidebar {...baseProps} isOrgAdmin={false} />);

    const trigger = screen.getByText("Rick Bowman").closest("button");
    fireEvent.click(trigger as HTMLButtonElement);

    expect(await screen.findByRole("link", { name: "Help" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Org Settings" })).not.toBeInTheDocument();
  });
});
