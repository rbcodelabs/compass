// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/acme/product/discovery" }))

import { WorkspaceSearchPalette } from "@/components/workspace-search-palette"
import { AgentRailProvider, useAgentRail } from "@/components/agent/agent-rail-context"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { isPillSelection } from "@/lib/selection-pill"

const OPP = "11111111-1111-4111-8111-111111111111"
const RECT = { left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20, x: 100, y: 200, toJSON: () => ({}) } as DOMRect

function selectNode(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  range.getBoundingClientRect = () => RECT
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
}

function Probe() {
  const { agentSeed } = useAgentRail()
  return <output data-testid="seed">{JSON.stringify(agentSeed)}</output>
}

function Page({ sheet = true, workspaceId, onSheetOpenChange }: { sheet?: boolean; workspaceId?: string; onSheetOpenChange?: (open: boolean) => void }) {
  return (
    <AgentRailProvider workspaceId={workspaceId}>
      <SidebarProvider><WorkspaceSearchPalette orgSlug="acme" workspaceSlug="product" /></SidebarProvider>
      <Probe />
      {sheet && (
        <Sheet open onOpenChange={onSheetOpenChange}>
          <SheetContent data-testid="panel" className="z-[60]">
            <SheetTitle>Opportunity</SheetTitle>
            <div data-ctx-entity-type="opportunity" data-ctx-entity-id={OPP} data-ctx-entity-title="Fix onboarding">
              <span className="contents" data-ctx-entity-type="opportunity" data-ctx-entity-id={OPP} data-ctx-field="Description">
                <p data-testid="description">Step 3 asks for a team invite before value</p>
              </span>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </AgentRailProvider>
  )
}

describe("selection pill inside the modal detail panel", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: "", groups: [] }) } as Response))
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.getSelection()?.removeAllRanges()
  })

  const showPill = async () => {
    render(<Page />)
    // Let the Sheet finish moving focus into itself; jsdom drops the selection when focus moves.
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    selectNode(screen.getByTestId("description"))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  }

  it("is offered for text selected in the Sheet, above the panel layer", async () => {
    await showPill()
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" })
    expect(toolbar).toBeInTheDocument()
    expect(toolbar.className).toContain("z-[80]")
    expect(screen.getByTestId("panel").className).toContain("z-[60]")
  })

  it("Ask… from the panel hands entity and field to the rail composer", async () => {
    await showPill()
    fireEvent.click(screen.getByRole("button", { name: "Ask…" }))
    expect(screen.getByRole("dialog", { name: "Search workspace" })).toHaveTextContent("Opportunity · Description")
    expect(screen.getByRole("dialog", { name: "Search workspace" })).toHaveTextContent("Fix onboarding")
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "summarise this" } })
    fireEvent.keyDown(input, { key: "Enter" })
    const seed = JSON.parse(screen.getByTestId("seed").textContent ?? "null")
    expect(seed.label).toBe("Opportunity · Description")
    expect(seed.summary).toBe("Fix onboarding")
    expect(seed.sourceUrl).toBe(`/acme/product/discovery/${OPP}`)
    expect(seed.text).toBe(
      `summarise this\n\nSelected from: Opportunity "Fix onboarding" (id ${OPP}) — field: Description\n> Step 3 asks for a team invite before value`,
    )
  })

  it("inline Ask sends the structured entity and field context to the agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === "/api/agent/turn"
        ? new Response("offline", { status: 500 })
        : ({ ok: true, json: async () => ({ query: "", groups: [] }) } as Response))
    vi.stubGlobal("fetch", fetchMock)
    render(<Page workspaceId="w1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    selectNode(screen.getByTestId("description"))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    fireEvent.click(screen.getByRole("button", { name: "Ask…" }))
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    fireEvent.change(input, { target: { value: "summarise this" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/agent/turn")
    const body = JSON.parse((post?.[1] as RequestInit).body as string)
    expect(body.message).toBe(
      `summarise this\n\nSelected from: Opportunity "Fix onboarding" (id ${OPP}) — field: Description\n> Step 3 asks for a team invite before value`,
    )
  })

  it("pressing the pill does not count as an outside press that dismisses the Sheet", async () => {
    const onOpenChange = vi.fn()
    render(<Page onSheetOpenChange={onOpenChange} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    selectNode(screen.getByTestId("description"))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const ask = screen.getByRole("button", { name: "Ask…" })
    fireEvent.pointerDown(ask)
    fireEvent.mouseDown(ask)
    fireEvent.pointerUp(ask)
    fireEvent.mouseUp(ask)
    fireEvent.click(ask)
    expect(onOpenChange).not.toHaveBeenCalledWith(false, expect.anything())
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  it("control: pressing the Sheet backdrop does dismiss it", async () => {
    const onOpenChange = vi.fn()
    render(<Page onSheetOpenChange={onOpenChange} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const behind = document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement
    fireEvent.pointerDown(behind)
    fireEvent.mouseDown(behind)
    fireEvent.pointerUp(behind)
    fireEvent.mouseUp(behind)
    fireEvent.click(behind)
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  it("opens the palette over the open Sheet and keeps both usable", async () => {
    render(<Page />)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    fireEvent.keyDown(document, { key: "k", metaKey: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const input = screen.getByRole("combobox", { name: "Search workspace" })
    expect(input).toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(screen.getByTestId("panel")).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "plan" } })
    expect(input).toHaveValue("plan")
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    // Both stay mounted and the palette keeps focus: the panel's focus trap did not reclaim it.
    expect(input).toHaveFocus()
    expect(screen.getByTestId("panel")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Search workspace" })).toBeInTheDocument()
  })
})

describe("isPillSelection exclusions", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    window.getSelection()?.removeAllRanges()
  })
  const pick = (html: string) => {
    document.body.innerHTML = html
    const target = document.getElementById("t")!
    const range = document.createRange()
    range.selectNodeContents(target)
    range.getBoundingClientRect = () => RECT
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    return isPillSelection(window.getSelection(), null)
  }

  it("allows plain text and text inside any dialog", () => {
    expect(pick('<p id="t">enough characters here</p>')).not.toBeNull()
    expect(pick('<div role="dialog"><p id="t">enough characters here</p></div>')).not.toBeNull()
    expect(pick('<div data-slot="sheet-content" role="dialog"><p id="t">enough characters here</p></div>')).not.toBeNull()
  })
  it("excludes the palette, the pill, fields and editable regions", () => {
    expect(pick('<div role="dialog" data-selection-pill-ignore=""><p id="t">enough characters here</p></div>')).toBeNull()
    expect(pick('<div data-selection-pill><p id="t">enough characters here</p></div>')).toBeNull()
    expect(pick('<textarea id="t">enough characters here</textarea>')).toBeNull()
    expect(pick('<div contenteditable="true"><p id="t">enough characters here</p></div>')).toBeNull()
  })
})
