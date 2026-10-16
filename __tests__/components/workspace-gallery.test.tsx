// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }))

import { WorkspaceGallery } from "@/components/workspace-selector/workspace-gallery"
import { recordWorkspaceVisit } from "@/components/workspace-selector/visits"
import type { SelectorWorkspace } from "@/components/workspace-selector/model"

// Node 26 ships an experimental localStorage that shadows jsdom's and has no clear().
const memory = new Map<string, string>()
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) },
})

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = vi.fn()

const ws = (slug: string, name: string, orgSlug = "acme", orgName = "Acme", extra: Partial<SelectorWorkspace> = {}): SelectorWorkspace =>
  ({ id: `${orgSlug}-${slug}`, name, slug, orgSlug, orgName, ...extra })

const many = [
  ws("alpha", "Alpha", "acme", "Acme", { memberCount: 4, description: "The first one" }),
  ws("beta", "Beta"), ws("gamma", "Gamma"), ws("delta", "Delta"),
  ws("eps", "Epsilon", "globex", "Globex"), ws("zeta", "Zeta", "globex", "Globex", { isReadOnly: true }),
]

const renderGallery = (workspaces = many, extra = {}) =>
  render(<WorkspaceGallery workspaces={workspaces} userName="Rick Bowman" userEmail="rick@x.com" {...extra} />)
const search = () => screen.getByRole("searchbox", { name: "Search workspaces" })

beforeEach(() => memory.clear())
afterEach(() => cleanup())

describe("WorkspaceGallery", () => {
  it("renders a heading, summary and one section per organization", () => {
    renderGallery()
    expect(screen.getByRole("heading", { level: 1, name: "Your workspaces" })).toBeInTheDocument()
    expect(screen.getByText("6 workspaces across 2 organizations.")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Acme" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Globex" })).toBeInTheDocument()
  })

  it("links each tile to the workspace's default landing page", () => {
    renderGallery()
    expect(screen.getByRole("link", { name: /^Epsilon/ })).toHaveAttribute("href", "/globex/eps/okrs")
  })

  it("filters on workspace and organization name, with counts and a no-results panel", () => {
    renderGallery()
    fireEvent.change(search(), { target: { value: "globex" } })
    expect(screen.queryByRole("link", { name: /^Beta/ })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /^Epsilon/ })).toBeInTheDocument()
    expect(screen.getByText("2 of 6 workspaces match “globex”.")).toBeInTheDocument()
    fireEvent.change(search(), { target: { value: "zzz" } })
    expect(screen.getByRole("heading", { name: /No workspaces match/ })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Clear search" }))
    expect(search()).toHaveValue("")
    expect(screen.getByRole("link", { name: /^Beta/ })).toBeInTheDocument()
  })

  it("Enter opens the first match only when there is a query; Esc clears it", () => {
    renderGallery()
    const click = vi.fn((e: Event) => e.preventDefault())
    screen.getAllByRole("link").forEach((a) => a.addEventListener("click", click))
    fireEvent.keyDown(search(), { key: "Enter" })
    expect(click).not.toHaveBeenCalled()
    fireEvent.change(search(), { target: { value: "epsilon" } })
    fireEvent.keyDown(search(), { key: "Enter" })
    expect(click).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(search(), { key: "Escape" })
    expect(search()).toHaveValue("")
  })

  it("ArrowDown from search focuses the first tile; ArrowLeft from it returns to search", () => {
    renderGallery()
    fireEvent.keyDown(search(), { key: "ArrowDown" })
    const first = document.querySelector<HTMLElement>("[data-wsx-item]")!
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(document.querySelectorAll<HTMLElement>("[data-wsx-item]")[1]).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" })
    fireEvent.keyDown(first, { key: "ArrowLeft" })
    expect(search()).toHaveFocus()
  })

  it("focuses search on '/' and Cmd+K", () => {
    renderGallery()
    fireEvent.keyDown(document.body, { key: "/" })
    expect(search()).toHaveFocus()
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: "k", metaKey: true })
    expect(search()).toHaveFocus()
  })

  it("shows 'Jump back in' only with more than four workspaces, no query and recorded visits", () => {
    const { unmount } = renderGallery()
    expect(screen.queryByRole("heading", { name: "Jump back in" })).not.toBeInTheDocument()
    unmount()
    recordWorkspaceVisit("globex/eps", Date.now(), "rick@x.com")
    renderGallery()
    const section = screen.getByRole("heading", { name: "Jump back in" }).closest("section")!
    expect(within(section).getByRole("link", { name: /^Epsilon/ })).toBeInTheDocument()
    fireEvent.change(search(), { target: { value: "a" } })
    expect(screen.queryByRole("heading", { name: "Jump back in" })).not.toBeInTheDocument()
  })

  it("never shows recents for a small set, and flags read-only workspaces", () => {
    recordWorkspaceVisit("acme/alpha", Date.now(), "rick@x.com")
    renderGallery(many.slice(0, 2))
    expect(screen.queryByRole("heading", { name: "Jump back in" })).not.toBeInTheDocument()
    cleanup()
    renderGallery([ws("ro", "Only Read", "acme", "Acme", { isReadOnly: true }), ws("b", "B")], { readOnlyNotice: true })
    expect(screen.getByText("Read-only")).toBeInTheDocument()
    expect(screen.getByText(/read-only access to these workspaces/)).toBeInTheDocument()
  })

  it("points Create workspace at the first org's settings", () => {
    renderGallery()
    expect(screen.getByRole("link", { name: /Create workspace/ })).toHaveAttribute("href", "/acme/settings")
  })
})
