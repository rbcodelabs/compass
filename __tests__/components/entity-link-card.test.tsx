// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { Markdown } from "@/components/agent/markdown"
import { WorkItemLinkScopeProvider } from "@/components/work-item-link-scope"

const openPanel = vi.fn()
vi.mock("@/components/panels/panel-context", () => ({ useOptionalPanelContext: () => ({ openPanel }) }))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const ID = "0b9a7f6e-3c1d-4e2a-8f5b-6d7c8e9fa0b1"
const summary = { type: "task", id: ID, title: "Ship the card", typeLabel: "Task", status: "IN_PROGRESS", meta: "HIGH", description: "Render links as cards." }

afterEach(() => {
  openPanel.mockClear()
  cleanup()
  vi.unstubAllGlobals()
})

describe("agent transcript link cards", () => {
  it("renders a Compass entity link as a card with live title and status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => summary })
    vi.stubGlobal("fetch", fetchMock)
    const href = `/acme/web/tasks/${ID}`
    const { container } = render(<Markdown>{`Created [the task](${href}) for you.`}</Markdown>)

    await waitFor(() => expect(screen.getByText("Ship the card")).toBeTruthy())
    expect(screen.getByText("In progress")).toBeTruthy()
    expect(container.querySelector('[data-entity-card="task"]')?.getAttribute("href")).toBe(href)
    expect(String(fetchMock.mock.calls[0][0])).toContain("type=task")
    expect(String(fetchMock.mock.calls[0][0])).toContain(`id=${ID}`)
  })

  it("falls back to a plain link when the reader cannot see the entity", async () => {
    const other = "1c0b8a7f-4d2e-4f3b-9a6c-7e8d9fa0b1c2"
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<Markdown>{`[hidden](/acme/web/tasks/${other})`}</Markdown>)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector("a")?.textContent).toBe("hidden"))
    expect(container.querySelector("[data-entity-card]")).toBeNull()
  })

  it("leaves non-entity and external links alone and never fetches for them", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<Markdown>{"[docs](https://example.com/x) and [board](/acme/web/tasks)"}</Markdown>)

    expect(container.querySelectorAll("a")).toHaveLength(2)
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  const solution = { type: "solution", id: ID, title: "Faster checkout", typeLabel: "Solution", status: "PLANNED", meta: null, description: null }
  const solutionHref = `/acme/web/discovery/${"2d1c9b8a-5e3f-4a4c-8b7d-8f9ea0b1c2d3"}?detail=solution%3A${ID}`

  it("opens a solution card as a panel on the current page instead of navigating", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => solution }))
    render(
      <WorkItemLinkScopeProvider orgSlug="acme" workspaceSlug="web">
        <Markdown>{`[sol](${solutionHref})`}</Markdown>
      </WorkItemLinkScopeProvider>,
    )
    const card = await waitFor(() => {
      const el = document.querySelector('[data-entity-card="solution"]')
      if (!el) throw new Error("no card")
      return el
    })
    expect(fireEvent.click(card)).toBe(false) // default prevented => no navigation
    expect(openPanel).toHaveBeenCalledWith("solution", ID)
    expect(fireEvent.click(card, { metaKey: true })).toBe(true) // modified click keeps the real link
    expect(openPanel).toHaveBeenCalledTimes(1)
  })

  it("keeps real navigation for a panel entity in another workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => solution }))
    render(
      <WorkItemLinkScopeProvider orgSlug="acme" workspaceSlug="other">
        <Markdown>{`[sol](${solutionHref})`}</Markdown>
      </WorkItemLinkScopeProvider>,
    )
    const card = await waitFor(() => {
      const el = document.querySelector('[data-entity-card="solution"]')
      if (!el) throw new Error("no card")
      return el
    })
    expect(fireEvent.click(card)).toBe(true)
    expect(openPanel).not.toHaveBeenCalled()
  })
})
