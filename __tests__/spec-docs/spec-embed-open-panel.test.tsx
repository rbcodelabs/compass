// @vitest-environment jsdom
/**
 * A spec doc card opens its record in the detail side panel instead of navigating away.
 *
 * The real PanelProvider is used with a mocked router, so "opens the panel" is observed as the URL it pushes (`?detail=kind:id`).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/acme/alpha/docs/d1",
  useSearchParams: () => new URLSearchParams(),
}))

import { PanelProvider } from "@/components/panels/panel-context"
import { SpecEmbedCard, type CardEditControls } from "@/components/docs/spec-embed-card"
import type { EmbedEntry } from "@/components/docs/doc-embed-cards"
import type { DocEmbedKind } from "@/lib/doc-embeds"

afterEach(() => {
  cleanup()
  nav.push.mockReset()
  nav.replace.mockReset()
})

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const entry = (kind: DocEmbedKind): EmbedEntry =>
  ({ status: "ready", card: { state: "ok", kind, id: ID, title: "Live title", status: "IDEA", facts: [], href: `/acme/alpha/x/${ID}` } }) as never
const EDIT: CardEditControls = { statuses: ["IDEA", "BUILDING"], save: vi.fn(async () => {}) }

function mount(kind: DocEmbedKind, { provider = true, edit = null }: { provider?: boolean; edit?: CardEditControls | null } = {}) {
  const card = <SpecEmbedCard kind={kind} entry={entry(kind)} edit={edit} onRemove={edit ? () => {} : null} />
  render(provider ? <PanelProvider orgSlug="acme" workspaceSlug="alpha">{card}</PanelProvider> : card)
  return screen.getByRole("link", { name: "Live title" })
}

/** Dispatches a click and reports whether anything called preventDefault on it (which is what stops a link navigating). */
function clickAndReport(el: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(event)
  return event.defaultPrevented
}
const detailPushes = () => nav.push.mock.calls.filter(([url]) => String(url).includes("detail="))

describe("card title opens the detail panel", () => {
  it.each(["solution", "assumption", "task", "opportunity", "experiment", "objective", "keyResult", "roadmapItem"] as const)(
    "a plain click on a %s card pushes ?detail= and prevents navigation",
    (kind) => {
      const link = mount(kind)
      expect(clickAndReport(link)).toBe(true)
      expect(nav.push).toHaveBeenCalledTimes(1)
      expect(nav.push).toHaveBeenCalledWith(`/acme/alpha/docs/d1?detail=${kind}%3A${ID}`, { scroll: false })
    },
  )

  it("keeps the real href on the link", () => {
    expect(mount("solution")).toHaveAttribute("href", `/acme/alpha/x/${ID}`)
  })

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ] as const)("%s-click does not open the panel and is not prevented", (_name, init) => {
    const link = mount("solution")
    expect(clickAndReport(link, init)).toBe(false)
    expect(detailPushes()).toHaveLength(0)
  })

  it.each(["metric", "doc", "artifact"] as const)("a %s card is not a panel type and is left to navigate by its href", (kind) => {
    const link = mount(kind)
    expect(clickAndReport(link)).toBe(false)
    expect(detailPushes()).toHaveLength(0)
    expect(link).toHaveAttribute("href", `/acme/alpha/x/${ID}`)
  })

  it("without a PanelProvider the link is left to navigate normally", () => {
    const link = mount("solution", { provider: false })
    expect(clickAndReport(link)).toBe(false)
    expect(detailPushes()).toHaveLength(0)
    expect(link).toHaveAttribute("href", `/acme/alpha/x/${ID}`)
  })
})

describe("editing controls do not open the panel", () => {
  it("Rename, the status select and the overflow menu leave the panel alone", () => {
    mount("solution", { edit: EDIT })
    fireEvent.click(screen.getByTestId("embed-card-menu"))
    fireEvent.click(screen.getByTestId("embed-card-menu"))
    fireEvent.change(screen.getByTestId("embed-status-select"), { target: { value: "BUILDING" } })
    fireEvent.click(screen.getByTestId("embed-title-edit"))
    expect(screen.getByTestId("embed-title-input")).toBeInTheDocument()
    expect(detailPushes()).toHaveLength(0)
  })
})
