// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
let pathname = "/acme/product/feedback"
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname }))

import { WorkspaceSearchPalette } from "@/components/workspace-search-palette"
import { AgentRailProvider, useAgentRail } from "@/components/agent/agent-rail-context"
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

  it("renders a User Guide group and navigates to its href on Enter", async () => {
    const resultsWithHelp = {
      query: "plan",
      groups: [
        { type: "opportunity", label: "Opportunities", items: [
          { type: "opportunity", id: "opp-1", title: "Plan onboarding", context: "ACTIVE", href: "/acme/product/discovery/opp-1" },
        ] },
        { type: "task", label: "Tasks", items: [
          { type: "task", id: "task-1", title: "Plan QA", context: "TODO · HIGH", href: "/acme/product/tasks/task-1" },
        ] },
        { type: "help", label: "User Guide", items: [
          { type: "help", id: "04-roadmap:not-yet-on-the-roadmap", title: "Roadmap", context: "Not Yet on the Roadmap", href: "/help/04-roadmap#not-yet-on-the-roadmap" },
        ] },
      ],
    }
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => resultsWithHelp } as Response)
    renderPalette()
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "plan" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })

    expect(screen.getByRole("group", { name: "User Guide" })).toBeInTheDocument()
    const helpOption = screen.getByRole("option", { name: /Roadmap/ })
    expect(helpOption).toHaveAttribute("href", "/help/04-roadmap#not-yet-on-the-roadmap")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(helpOption).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(push).toHaveBeenCalledWith("/help/04-roadmap#not-yet-on-the-roadmap")
  })
})

function RailProbe() {
  const { agentSeed, open } = useAgentRail()
  return <output data-testid="rail">{JSON.stringify({ open, seed: agentSeed })}</output>
}

function renderAskPalette() {
  return render(
    <AgentRailProvider>
      <SidebarProvider><WorkspaceSearchPalette orgSlug="acme" workspaceSlug="product" /></SidebarProvider>
      <RailProbe />
    </AgentRailProvider>
  )
}

const railState = () => JSON.parse(screen.getByTestId("rail").textContent ?? "{}") as { open: boolean; seed: { text: string; label?: string; sourceUrl?: string } | null }

describe("WorkspaceSearchPalette Ask AI", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => results } as Response))
    Element.prototype.scrollIntoView = vi.fn()
    push.mockReset()
    pathname = "/acme/product/feedback"
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.getSelection()?.removeAllRanges()
  })

  const openPalette = () => {
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    return screen.getByRole("combobox", { name: "Search workspace" })
  }

  it("uses the merged placeholder and shows a Search badge by default", () => {
    renderAskPalette()
    const input = openPalette()
    expect(input).toHaveAttribute("placeholder", "Search or ask Compass…")
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Search")
  })

  it("stays search-first for a lookup, with Ask AI as the last row", async () => {
    renderAskPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "plan" } })
    expect(screen.queryByRole("option", { name: /Ask AI/ })).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(3)
    expect(options[2]).toHaveTextContent("Ask AI: “plan”")
    expect(options[0]).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Search")
    // Arrow up from the first row wraps to the Ask row.
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(options[2]).toHaveAttribute("aria-selected", "true")
  })

  it("leads with Ask AI for a question and Enter hands the query to the rail", async () => {
    renderAskPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "why is onboarding drop-off up?" } })
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Ask AI")
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Ask AI: “why is onboarding drop-off up?”")
    expect(railState().open).toBe(false)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const { open, seed } = railState()
    expect(open).toBe(true)
    expect(seed?.text).toBe("why is onboarding drop-off up?")
    expect(seed?.label).toBeUndefined()
    expect(push).not.toHaveBeenCalled()
  })

  it("Tab forces ask mode and Cmd+Enter promotes to the rail from a search-first query", async () => {
    renderAskPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "onboarding" } })
    fireEvent.keyDown(input, { key: "Tab" })
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Ask AI")
    fireEvent.keyDown(input, { key: "Enter", metaKey: true })
    expect(railState().seed?.text).toBe("onboarding")
  })

  it("does not trigger Ask on Enter while search results are still loading", async () => {
    renderAskPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "onboarding" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(railState().open).toBe(false)
  })

  it("opens in ask mode with selected page text attached as context", () => {
    renderAskPalette()
    const p = document.createElement("p")
    p.textContent = "Step 3 asks for a team invite"
    document.body.appendChild(p)
    const range = document.createRange()
    range.selectNodeContents(p)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    const input = openPalette()
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Ask AI")
    expect(screen.getByRole("dialog")).toHaveTextContent("“Step 3 asks for a team invite”")
    fireEvent.change(input, { target: { value: "summarise this" } })
    fireEvent.keyDown(input, { key: "Enter" })

    const { seed } = railState()
    expect(seed?.text).toBe("summarise this\n\n> Step 3 asks for a team invite")
    expect(seed?.label).toBe("Selected text")
    expect(seed?.sourceUrl).toBe(window.location.pathname + window.location.search)
    p.remove()
  })

  it("is plain search without an agent rail (no badge, no Ask row)", async () => {
    renderPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "why is onboarding drop-off up?" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByTestId("palette-mode")).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Ask AI/ })).not.toBeInTheDocument()
  })

  it("hides Ask on the full-page agent screen, where the rail is unavailable", () => {
    pathname = "/acme/product/agent"
    renderAskPalette()
    const input = openPalette()
    fireEvent.change(input, { target: { value: "why is onboarding drop-off up?" } })
    expect(screen.queryByTestId("palette-mode")).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Ask AI/ })).not.toBeInTheDocument()
  })
})
