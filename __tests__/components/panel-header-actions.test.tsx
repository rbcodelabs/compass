// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { useState } from "react"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import {
  PanelHeaderActionsContext,
  PanelHeaderIcons,
  usePanelHeaderActions,
  type PanelHeaderConfig,
} from "@/components/panels/panel-header-actions"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A stand-in for PanelShell: provides the setter and renders whatever the open panel declared. */
function Shell({ fallback = null, children }: { fallback?: string | null; children: React.ReactNode }) {
  const [config, setConfig] = useState<PanelHeaderConfig | null>(null)
  return (
    <PanelHeaderActionsContext.Provider value={setConfig}>
      <div data-testid="header"><PanelHeaderIcons config={config} orgSlug="acme" workspaceSlug="alpha" fallbackFullPageHref={fallback} /></div>
      {children}
    </PanelHeaderActionsContext.Provider>
  )
}

function Panel({ config, show = true }: { config: PanelHeaderConfig; show?: boolean }) {
  const inShell = usePanelHeaderActions(show ? config : {})
  return <p>{inShell ? "in shell" : "standalone"}</p>
}

describe("panel header actions", () => {
  it("renders a panel's declared actions in the header as icon buttons with accessible names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ available: false }) })))
    render(
      <Shell>
        <Panel config={{ fullPageHref: "/acme/alpha/feedback", decision: { subjectType: "FEEDBACK", subjectId: "f1", subjectTitle: "Slow request" } }} />
      </Shell>,
    )

    const header = screen.getByTestId("header")
    const decision = await screen.findByRole("link", { name: "Request decision" })
    expect(header).toContainElement(decision)
    expect(decision).toHaveAttribute("href", "/acme/alpha/decisions/new?subjectType=FEEDBACK&subjectId=f1&subjectTitle=Slow+request")
    expect(decision).toHaveAttribute("title", "Request decision")
    expect(decision.textContent).toBe("") // icon only: no label text in the header

    const fullPage = screen.getByRole("link", { name: "Open full page" })
    expect(fullPage).toHaveAttribute("href", "/acme/alpha/feedback")
    // fixed order: Request decision, then Open full page
    expect(decision.compareDocumentPosition(fullPage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("uses the shell's route for panels that do not declare one, and lets a declaration win", async () => {
    const { rerender } = render(<Shell fallback="/acme/alpha/tasks/t1"><Panel config={{}} /></Shell>)
    expect(await screen.findByRole("link", { name: "Open full page" })).toHaveAttribute("href", "/acme/alpha/tasks/t1")

    rerender(<Shell fallback="/acme/alpha/tasks/t1"><Panel config={{ fullPageHref: "/acme/alpha/other" }} /></Shell>)
    await waitFor(() => expect(screen.getByRole("link", { name: "Open full page" })).toHaveAttribute("href", "/acme/alpha/other"))
  })

  it("clears the header when the panel unmounts or has nothing to declare yet", async () => {
    const { rerender } = render(<Shell><Panel config={{ fullPageHref: "/acme/alpha/x" }} /></Shell>)
    expect(await screen.findByRole("link", { name: "Open full page" })).toBeInTheDocument()

    rerender(<Shell><Panel config={{ fullPageHref: "/acme/alpha/x" }} show={false} /></Shell>)
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open full page" })).toBeNull())

    rerender(<Shell><Panel config={{ fullPageHref: "/acme/alpha/x" }} /></Shell>)
    expect(await screen.findByRole("link", { name: "Open full page" })).toBeInTheDocument()
    rerender(<Shell>{null}</Shell>)
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open full page" })).toBeNull())
  })

  it("reports whether a shell is present, so a full page keeps its inline controls", () => {
    render(<Panel config={{ fullPageHref: "/x" }} />)
    expect(screen.getByText("standalone")).toBeInTheDocument()
    cleanup()
    render(<Shell><Panel config={{ fullPageHref: "/x" }} /></Shell>)
    expect(screen.getByText("in shell")).toBeInTheDocument()
  })

  it("shows Follow as an icon-only toggle when following is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ available: true, following: false }) })))
    render(<Shell><Panel config={{ follow: { subjectType: "SOLUTION", subjectId: "s1" } }} /></Shell>)

    const follow = await screen.findByRole("button", { name: "Follow" })
    expect(follow).toHaveAttribute("aria-pressed", "false")
    expect(follow.textContent).toBe("")
  })
})
