// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/rbcodelabs/compass/okrs",
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }))

vi.mock("@/lib/meta-feedback-actions", () => ({ sendCompassFeedback: vi.fn() }))

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}))

import { MobileHeader } from "@/components/mobile-header"

const baseProps = {
  orgSlug: "rbcodelabs",
  workspaceSlug: "compass",
  workspaceName: "Compass",
  userName: "Rick Bowman",
  userEmail: "rick@rbcodelabs.com",
}

function openAccountMenu(isOrgAdmin = false) {
  render(<MobileHeader {...baseProps} isOrgAdmin={isOrgAdmin} />)
  fireEvent.click(screen.getByRole("button", { name: "Account" }))
}

afterEach(cleanup)

describe("MobileHeader account menu", () => {
  /**
   * Mirrors the equivalent assertion in sidebar.test.tsx. The account-wide
   * `/settings/*` routes have no main-nav entry and no workspace-scoped
   * equivalent, so this dropdown is their only route into the UI — on mobile
   * it is the *only* one at all, since the sidebar is hidden below `md`.
   * `/settings/passkeys` shipped unreachable once because every test navigated
   * to it by URL; assert the link exists, not merely that the page renders.
   */
  it("links to both account-wide settings routes", async () => {
    openAccountMenu()

    expect(await screen.findByRole("link", { name: "My agents" })).toHaveAttribute(
      "href",
      "/settings/agents"
    )
    expect(await screen.findByRole("link", { name: "Passkeys" })).toHaveAttribute(
      "href",
      "/settings/passkeys"
    )
  })

  it("keeps workspace-scoped and User Guide links alongside them", async () => {
    openAccountMenu(true)

    expect(await screen.findByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/rbcodelabs/compass/settings"
    )
    expect(await screen.findByRole("link", { name: "Org Settings" })).toHaveAttribute(
      "href",
      "/rbcodelabs/settings"
    )
    expect(await screen.findByRole("link", { name: "User Guide" })).toHaveAttribute("href", "/help")
  })

  it("hides Org Settings from non-admins", async () => {
    openAccountMenu(false)

    expect(await screen.findByRole("link", { name: "User Guide" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Org Settings" })).not.toBeInTheDocument()
  })
})
