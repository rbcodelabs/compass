// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

let pathname = "/acme/alpha/roadmap"
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn() }) }))

import { WorkspacePicker } from "@/components/workspace-selector/workspace-picker"
import { recordWorkspaceVisit } from "@/components/workspace-selector/visits"
import type { SelectorWorkspace } from "@/components/workspace-selector/model"
import { SidebarMenu, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

// Node 26 ships an experimental localStorage that shadows jsdom's and has no clear().
const memory = new Map<string, string>()
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) },
})

const ws = (slug: string, name: string, orgSlug = "acme", orgName = "Acme", extra: Partial<SelectorWorkspace> = {}): SelectorWorkspace =>
  ({ id: `${orgSlug}-${slug}`, name, slug, orgSlug, orgName, ...extra })

const few = [ws("alpha", "Alpha"), ws("beta", "Beta")]
const many = [
  ws("alpha", "Alpha"), ws("beta", "Beta"), ws("gamma", "Gamma"), ws("delta", "Delta"),
  ws("eps", "Epsilon", "globex", "Globex"), ws("zeta", "Zeta", "globex", "Globex", { isReadOnly: true }),
]

function renderPicker(workspaces: SelectorWorkspace[]) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarMenu><SidebarMenuItem>
          <WorkspacePicker workspaces={workspaces} orgSlug="acme" workspaceSlug="alpha" workspaceName="Alpha" />
        </SidebarMenuItem></SidebarMenu>
      </SidebarProvider>
    </TooltipProvider>
  )
}
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Switch workspace. Current workspace: Alpha" }))
  return screen.findByRole("dialog", { name: "Switch workspace" })
}

beforeEach(() => { pathname = "/acme/alpha/roadmap"; memory.clear() })
afterEach(() => cleanup())

describe("WorkspacePicker", () => {
  it("keeps the trigger's accessible name and shows the current workspace", () => {
    renderPicker(few)
    const trigger = screen.getByRole("button", { name: "Switch workspace. Current workspace: Alpha" })
    expect(trigger).toHaveTextContent("Alpha")
  })

  it("opens a searchable popout focused on the search box", async () => {
    renderPicker(few)
    const dialog = await open()
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Find a workspace" })).toHaveFocus())
  })

  it("links each row to the same section of the target workspace, including across orgs", async () => {
    renderPicker(many)
    const dialog = await open()
    expect(within(dialog).getByRole("link", { name: /^Beta/ })).toHaveAttribute("href", "/acme/beta/roadmap")
    expect(within(dialog).getByRole("link", { name: /^Epsilon/ })).toHaveAttribute("href", "/globex/eps/roadmap")
  })

  it("marks the current workspace and flags read-only ones", async () => {
    renderPicker(many)
    const dialog = await open()
    expect(within(dialog).getByRole("link", { name: /^Alpha/ })).toHaveAttribute("aria-current", "true")
    expect(within(dialog).getByText("Read-only")).toBeInTheDocument()
  })

  it("groups by organization only when there is more than one", async () => {
    const { unmount } = renderPicker(few)
    let dialog = await open()
    expect(within(dialog).queryByRole("group", { name: "Acme" })).not.toBeInTheDocument()
    unmount()
    renderPicker(many)
    dialog = await open()
    expect(within(dialog).getByRole("group", { name: "Acme" })).toBeInTheDocument()
    expect(within(dialog).getByRole("group", { name: "Globex" })).toBeInTheDocument()
  })

  it("filters by workspace or organization name and shows an empty state", async () => {
    renderPicker(many)
    const dialog = await open()
    const input = within(dialog).getByRole("textbox", { name: "Find a workspace" })
    fireEvent.change(input, { target: { value: "globex" } })
    expect(within(dialog).getByRole("link", { name: /^Epsilon/ })).toBeInTheDocument()
    expect(within(dialog).queryByRole("link", { name: /^Beta/ })).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(within(dialog).getByText("No workspaces match")).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear search" }))
    expect(input).toHaveValue("")
    expect(within(dialog).getByRole("link", { name: /^Beta/ })).toBeInTheDocument()
  })

  it("moves focus with the arrow keys and back to search from the first row", async () => {
    renderPicker(many)
    const dialog = await open()
    const input = within(dialog).getByRole("textbox", { name: "Find a workspace" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const links = Array.from(dialog.querySelectorAll<HTMLElement>("[data-wsx-item]"))
    expect(links[0]).toHaveFocus()
    fireEvent.keyDown(links[0], { key: "ArrowDown" })
    expect(links[1]).toHaveFocus()
    fireEvent.keyDown(links[1], { key: "ArrowUp" })
    fireEvent.keyDown(links[0], { key: "ArrowUp" })
    expect(input).toHaveFocus()
  })

  it("shows a Recent group only with more than four workspaces and recorded visits", async () => {
    const { unmount } = renderPicker(many)
    let dialog = await open()
    expect(within(dialog).queryByRole("group", { name: "Recent" })).not.toBeInTheDocument()
    unmount()
    recordWorkspaceVisit("globex/eps", Date.now())
    renderPicker(many)
    dialog = await open()
    const recent = within(dialog).getByRole("group", { name: "Recent" })
    expect(within(recent).getByRole("link", { name: /^Epsilon/ })).toBeInTheDocument()
  })

  it("offers the full gallery and workspace creation in the footer", async () => {
    renderPicker(many)
    const dialog = await open()
    expect(within(dialog).getByRole("link", { name: "All workspaces" })).toHaveAttribute("href", "/dashboard")
    expect(within(dialog).getByRole("link", { name: "Create workspace" })).toHaveAttribute("href", "/acme/settings")
  })

  it("omits the gallery link when it is the only workspace", async () => {
    renderPicker([ws("alpha", "Alpha")])
    const dialog = await open()
    expect(within(dialog).queryByRole("link", { name: "All workspaces" })).not.toBeInTheDocument()
    expect(within(dialog).getByText("No other workspaces")).toBeInTheDocument()
  })
})
