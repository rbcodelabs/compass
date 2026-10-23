// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
let pathname = "/acme/product/feedback"
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname, useSearchParams: () => new URLSearchParams() }))

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
  const { agentSeed, open, conversationId } = useAgentRail()
  return <output data-testid="rail">{JSON.stringify({ open, seed: agentSeed, conversationId })}</output>
}

function renderAskPalette(workspaceId?: string) {
  return render(
    <AgentRailProvider workspaceId={workspaceId}>
      <SidebarProvider><WorkspaceSearchPalette orgSlug="acme" workspaceSlug="product" /></SidebarProvider>
      <RailProbe />
    </AgentRailProvider>
  )
}

const railState = () => JSON.parse(screen.getByTestId("rail").textContent ?? "{}") as { open: boolean; conversationId: string | null; seed: { text: string; label?: string; sourceUrl?: string } | null }

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

describe("WorkspaceSearchPalette inline Ask AI", () => {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const encode = (text: string) => new TextEncoder().encode(text)
  const run = (over: Record<string, unknown> = {}) => ({ id: "r1", status: "SUCCEEDED", done: true, startedByUserId: "u1", ...over })
  const answerText = (t: string) => ({ message: { message: { content: [{ type: "text", text: t }] } } })
  const QUESTION = "why is onboarding drop-off up?"

  /** Routes the three endpoints the inline ask touches. `finish` ends a held-open run stream. */
  function routeFetch(options: { turn?: () => Response; holdOpen?: boolean } = {}) {
    let finish: () => void = () => {}
    const calls: { url: string; init?: RequestInit }[] = []
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith("/api/workspace-search")) return { ok: true, json: async () => results } as Response
      if (url === "/api/agent/turn") {
        return options.turn?.() ?? new Response(JSON.stringify({ runId: "r1", conversationId: "c1" }), { status: 202 })
      }
      if (url === "/api/agent/runs/r1" && init?.method === "DELETE") return new Response(null, { status: 200 })
      if (url.startsWith("/api/agent/runs/r1/stream")) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encode(frame("run", run({ done: false, status: "RUNNING" }))))
            controller.enqueue(encode(frame("event", { seq: 1, type: "agent", payload: answerText("Step 3 asks for an invite.") })))
            const end = () => { controller.enqueue(encode(frame("run", run()))); controller.enqueue(encode(frame("done", {}))); controller.close() }
            if (options.holdOpen) finish = end
            else end()
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    return { calls, finish: () => finish() }
  }

  const turnPosts = (calls: { url: string; init?: RequestInit }[]) => calls.filter((c) => c.url === "/api/agent/turn")

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn())
    Element.prototype.scrollIntoView = vi.fn()
    push.mockReset()
    pathname = "/acme/product/feedback"
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10) })
  const askInline = async () => {
    renderAskPalette("w1")
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: QUESTION } })
    fireEvent.keyDown(input, { key: "Enter" })
    await settle()
    return input
  }

  it("streams the answer inside the palette without opening the rail", async () => {
    const { calls } = routeFetch()
    await askInline()
    expect(turnPosts(calls)).toHaveLength(1)
    expect(JSON.parse(turnPosts(calls)[0].init?.body as string)).toMatchObject({ workspaceId: "w1", message: QUESTION })
    expect(screen.getByRole("dialog")).toHaveTextContent("Step 3 asks for an invite.")
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    expect(railState().open).toBe(false)
    expect(railState().seed).toBeNull()
  })

  it("shows a Stop button while streaming and Esc stops the turn without closing", async () => {
    const { calls } = routeFetch({ holdOpen: true })
    const input = await askInline()
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument()
    expect(input).toHaveAttribute("readonly")

    fireEvent.keyDown(document, { key: "Escape" })
    await settle()
    expect(calls.some((c) => c.url === "/api/agent/runs/r1" && c.init?.method === "DELETE")).toBe(true)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("Stop button cancels the run", async () => {
    const { calls } = routeFetch({ holdOpen: true })
    await askInline()
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }))
    await settle()
    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1)
  })

  it("Cmd+Enter promotes the in-flight conversation to the rail without sending again", async () => {
    const { calls } = routeFetch({ holdOpen: true })
    const input = await askInline()
    fireEvent.keyDown(input, { key: "Enter", metaKey: true })
    await settle()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(railState()).toMatchObject({ open: true, conversationId: "c1" })
    expect(turnPosts(calls)).toHaveLength(1)
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false)
  })

  it("shows an inline error with a retry that asks again", async () => {
    const { calls } = routeFetch({ turn: () => new Response("agent offline", { status: 500 }) })
    await askInline()
    expect(screen.getByRole("alert")).toHaveTextContent("agent offline")
    expect(screen.getByRole("button", { name: /Open in Agent/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await settle()
    expect(turnPosts(calls)).toHaveLength(2)
  })

  it("Back returns to the list and a new query leaves the answer", async () => {
    routeFetch()
    const input = await askInline()
    fireEvent.click(screen.getByRole("button", { name: /Back/ }))
    expect(screen.queryByText("Step 3 asks for an invite.")).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute("readonly")
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Ask AI")
  })

  it("passes the page selection to the agent as a quoted block", async () => {
    const { calls } = routeFetch()
    const p = document.createElement("p")
    p.textContent = "Step 3 asks for a team invite"
    document.body.appendChild(p)
    const range = document.createRange()
    range.selectNodeContents(p)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    renderAskPalette("w1")
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "summarise this" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await settle()
    expect(JSON.parse(turnPosts(calls)[0].init?.body as string).message).toBe("summarise this\n\n> Step 3 asks for a team invite")
    p.remove()
    window.getSelection()?.removeAllRanges()
  })
})

describe("WorkspaceSearchPalette selection pill", () => {
  const selectText = (text: string) => {
    const p = document.createElement("p")
    p.textContent = text
    document.body.appendChild(p)
    const range = document.createRange()
    range.selectNodeContents(p)
    range.getBoundingClientRect = () => ({ left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
    return p
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => results } as Response))
    Element.prototype.scrollIntoView = vi.fn()
    pathname = "/acme/product/feedback"
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.getSelection()?.removeAllRanges()
  })

  it("Ask… opens the palette in ask mode with the selection as context", async () => {
    renderAskPalette("w1")
    const p = selectText("Step 3 asks for a team invite")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    fireEvent.click(screen.getByRole("button", { name: "Ask…" }))
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Ask AI")
    expect(screen.getByRole("dialog")).toHaveTextContent("“Step 3 asks for a team invite”")
    p.remove()
  })

  it("Find similar opens a search-first palette prefilled from the selection", async () => {
    renderAskPalette("w1")
    const p = selectText("Step 3 asks for a team invite before value")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    fireEvent.click(screen.getByRole("button", { name: "Find similar" }))
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    expect(input).toHaveValue("Step 3 asks for a team invite before value")
    // Eight words would normally be ask-first; Find similar is a lookup.
    expect(screen.getByTestId("palette-mode")).toHaveTextContent("Search")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(fetch).toHaveBeenCalled()
    p.remove()
  })

  it("is not offered for short selections or while the palette is open", async () => {
    renderAskPalette("w1")
    const short = selectText("tiny")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument()
    short.remove()
    const p = selectText("Step 3 asks for a team invite")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument()
    p.remove()
  })

  it("dismisses on Escape and on scroll", async () => {
    renderAskPalette("w1")
    const p = selectText("Step 3 asks for a team invite")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()

    document.dispatchEvent(new Event("selectionchange"))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    fireEvent.scroll(window)
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
    p.remove()
  })

  it("dismisses when the selection collapses", async () => {
    renderAskPalette("w1")
    const p = selectText("Step 3 asks for a team invite")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
    p.remove()
  })

  it("is not shown without an agent rail", async () => {
    renderPalette()
    const p = selectText("Step 3 asks for a team invite")
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
    p.remove()
  })
})
