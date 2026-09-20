// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }))

import { MarketingNavigation } from "@/components/marketing/marketing-navigation"
import { HeroSection } from "@/components/marketing/hero-section"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import type { MarketingViewer } from "@/lib/marketing-viewer"

const workspaces = [
  { id: "ws-1", name: "Compass", slug: "compass", orgSlug: "rbcodelabs", orgName: "RB Code Labs" },
  { id: "ws-2", name: "Compass", slug: "compass", orgSlug: "acme", orgName: "Acme" },
]

const user = { name: "Rick Bowman", email: "rick@example.com", image: null }

afterEach(cleanup)

describe("MarketingNavigation", () => {
  it("preserves the signed-out navigation", () => {
    render(<MarketingNavigation viewer={{ kind: "signed-out" }} />)
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login")
    expect(screen.queryByRole("button", { name: "Account menu" })).not.toBeInTheDocument()
  })

  it("shows setup and initials for a user without workspaces", async () => {
    render(<MarketingNavigation viewer={{ kind: "no-workspaces", user, workspaces: [] }} />)
    expect(screen.getByRole("link", { name: "Set up workspace" })).toHaveAttribute("href", "/onboarding")
    expect(screen.getByText("RB")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }))
    expect(await screen.findByText("rick@example.com")).toBeInTheDocument()
    expect(within(await screen.findByRole("menu")).getByRole("link", { name: "Set up workspace" })).toHaveAttribute("href", "/onboarding")
    expect(screen.getByRole("link", { name: "User Guide" })).toHaveAttribute("href", "/help")
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument()
  })

  it("shows an image-backed avatar and dashboard for one workspace", () => {
    const viewer: MarketingViewer = {
      kind: "single-workspace",
      user: { ...user, image: "https://example.com/rick.png" },
      workspaces: [workspaces[0]],
    }
    render(<MarketingNavigation viewer={viewer} />)
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard")
    expect(screen.getByRole("button", { name: "Account menu" }).querySelector('[data-has-image="true"]')).toBeInTheDocument()
  })

  it("shows an accessible selector with organization-qualified duplicate names", async () => {
    render(<MarketingNavigation viewer={{ kind: "multiple-workspaces", user, workspaces }} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose workspace" }))
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByRole("link", { name: "Compass RB Code Labs" })).toHaveAttribute("href", "/rbcodelabs/compass/okrs")
    expect(within(menu).getByRole("link", { name: "Compass Acme" })).toHaveAttribute("href", "/acme/compass/okrs")
    expect(within(menu).getByRole("link", { name: "All workspaces" })).toHaveAttribute("href", "/dashboard")
  })
})

describe("marketing calls to action", () => {
  it("keeps signed-out hero and footer sign-in messaging", () => {
    render(<><HeroSection viewer={{ kind: "signed-out" }} /><MarketingFooter viewer={{ kind: "signed-out" }} /></>)
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2)
    expect(screen.getByRole("link", { name: "Start for free →" })).toHaveAttribute("href", "/dashboard")
    expect(screen.getByRole("link", { name: "User Guide" })).toHaveAttribute("href", "/help")
  })

  it("shows setup CTAs and no sign-in links for a user without workspaces", () => {
    render(<><HeroSection viewer={{ kind: "no-workspaces", user, workspaces: [] }} /><MarketingFooter viewer={{ kind: "no-workspaces", user, workspaces: [] }} /></>)
    expect(screen.getAllByRole("link", { name: "Set up workspace" })).toHaveLength(2)
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument()
  })

  it.each<MarketingViewer>([
    { kind: "single-workspace", user, workspaces: [workspaces[0]] },
    { kind: "multiple-workspaces", user, workspaces },
  ])("shows authenticated workspace CTAs for $kind", (viewer) => {
    render(<><HeroSection viewer={viewer} /><MarketingFooter viewer={viewer} /></>)
    expect(screen.getByRole("link", { name: "Open Compass" })).toHaveAttribute("href", "/dashboard")
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard")
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument()
  })
})
