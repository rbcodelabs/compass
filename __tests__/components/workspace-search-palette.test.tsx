// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

import { WorkspaceSearchPalette } from "@/components/workspace-search-palette"
import { SidebarProvider } from "@/components/ui/sidebar"

const results = {
  query: "plan",
  groups: [
    { type: "opportunity", label: "Opportunities", items: [
      { type: "opportunity", id: "opp-1", title: "Plan onboarding", context: "ACTIVE", href: "/acme/product/discovery/opp-1" },
    ] },
    { type: "task", label: "Tasks", items: [
      { type: "task", id: "task-1", title: "Plan QA", context: "TODO · HIGH", href: "/acme/product/tasks/task-1" },
    ] },
  ],
}

function renderPalette() {
  return render(<SidebarProvider><WorkspaceSearchPalette orgSlug="acme" workspaceSlug="product" /></SidebarProvider>)
}

function renderPaletteWithProps(orgSlug = "acme", workspaceSlug = "product") {
  return render(
    <SidebarProvider>
      <WorkspaceSearchPalette orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
    </SidebarProvider>
  )
}

describe("WorkspaceSearchPalette", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn())
    Element.prototype.scrollIntoView = vi.fn()
    push.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("opens from the Search affordance and exact Meta/Ctrl+K shortcuts", async () => {
    renderPalette()
    fireEvent.click(screen.getByRole("button", { name: "Search workspace" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass("z-[70]")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await act(async () => { await vi.runAllTimersAsync() })
    expect(screen.getByRole("button", { name: "Search workspace" })).toHaveFocus()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("debounces searches, renders grouped options, wraps arrows, and navigates the active result", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => results } as Response)
    renderPalette()
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "plan" } })
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("group", { name: "Opportunities" })).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(2)
    expect(screen.getByRole("option", { name: /Plan onboarding/ })).toHaveAttribute(
      "href",
      "/acme/product/discovery/opp-1"
    )

    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(screen.getByRole("option", { name: /Plan QA/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByRole("option", { name: /Plan onboarding/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(push).toHaveBeenCalledWith("/acme/product/discovery/opp-1")
  })

  it("aborts superseded requests and ignores a stale response", async () => {
    let resolveFirst!: (value: Response) => void
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    vi.mocked(fetch)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ query: "plans", groups: [] }) } as Response)
    renderPalette()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "plan" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]?.signal
    fireEvent.change(input, { target: { value: "plans" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(firstSignal?.aborted).toBe(true)
    await act(async () => resolveFirst({ ok: true, json: async () => results } as Response))
    expect(screen.getByText("No results for “plans”")).toBeInTheDocument()
  })

  it("invalidates an active request immediately when a new valid query is typed", async () => {
    let resolveFirst!: (value: Response) => void
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    vi.mocked(fetch).mockReturnValueOnce(first)
    renderPalette()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })

    fireEvent.change(input, { target: { value: "plan" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]?.signal

    fireEvent.change(input, { target: { value: "plans" } })
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.queryByRole("option")).not.toBeInTheDocument()

    await act(async () => resolveFirst({ ok: true, json: async () => results } as Response))
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(push).not.toHaveBeenCalled()
  })

  it("invalidates results immediately when the workspace changes", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => results } as Response)
    const { rerender } = renderPaletteWithProps()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "plan" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getAllByRole("option")).toHaveLength(2)

    rerender(
      <SidebarProvider>
        <WorkspaceSearchPalette orgSlug="acme" workspaceSlug="other" />
      </SidebarProvider>
    )
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
  })

  it("shows instruction, loading, empty, and recoverable error states", async () => {
    let rejectSearch!: (reason: Error) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((_, reject) => { rejectSearch = reject }))
    renderPalette()
    fireEvent.click(screen.getByRole("button", { name: "Search workspace" }))
    expect(screen.getByText("Type at least 2 characters to search.")).toBeInTheDocument()
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "plan" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(input).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Searching…")).toBeInTheDocument()
    await act(async () => rejectSearch(new Error("network")))
    expect(screen.getByText("Search failed. Try again.")).toBeInTheDocument()
  })

  it("keeps the combobox expanded when an empty result popup is visible", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ query: "missing", groups: [] }) } as Response)
    renderPalette()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "missing" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getByText("No results for “missing”")).toBeInTheDocument()
    expect(input).toHaveAttribute("aria-expanded", "true")
  })
})
