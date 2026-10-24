// @vitest-environment jsdom
/**
 * Live refresh inside the real CanvasDocEditor: a newer server canvas is adopted by a clean editor (diffed by id, history and
 * save base reset) and held back behind a banner when the user has unsaved work. Adopted content must never be saved.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => {
  const none = async () => ({})
  return {
    updateDoc: vi.fn(async (..._args: unknown[]) => ({ revision: "rev-saved" })),
    createDocVersion: none, restoreDocVersion: none, buildCanvasTree: none, resolveCanvasCardRefs: async () => ({}),
  }
})
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => actions)
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: vi.fn() }))
vi.mock("@/components/thinking-model/thinking-model-provider", () => ({ useLabels: () => ({ objective: { lowerPlural: "objectives" } }) }))
vi.mock("@/components/docs/docs-library-button", () => ({ DocsLibraryButton: () => null }))
vi.mock("@/components/docs/canvas/canvas-tree-dialog", () => ({ CanvasTreeDialog: () => null }))
vi.mock("@/components/docs/canvas/canvas-card-picker", () => ({ CanvasCardPicker: () => null }))
vi.mock("@/components/docs/doc-version-history-panel", () => ({ DocVersionHistoryPanel: () => null }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { CanvasDocEditor } from "@/components/docs/canvas/canvas-doc-editor"
import { useLiveRefresh } from "@/hooks/use-live-refresh"
import { serializeJsonCanvas, type JsonCanvas } from "@/lib/json-canvas"

beforeAll(() => {
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor() {} })
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never
  }
})

afterEach(() => {
  cleanup()
  actions.updateDoc.mockReset()
  actions.updateDoc.mockImplementation(async () => ({ revision: "rev-saved" }))
})

const canvasOf = (...nodes: Array<{ id: string; text: string; x?: number; y?: number }>): JsonCanvas => ({
  nodes: nodes.map((n) => ({ id: n.id, type: "text" as const, text: n.text, x: n.x ?? 0, y: n.y ?? 0, width: 200, height: 80 })),
  edges: [],
})

type Props = { revision: string; canvas: JsonCanvas; name?: string | null; source?: string }
function tree({ revision, canvas, name = null, source = "MCP" }: Props) {
  return (
    <CanvasDocEditor
      doc={{ id: "d1", title: "Board", content: serializeJsonCanvas(canvas), icon: null, revision }}
      lastWriter={{ name, source }}
      orgSlug="acme" workspaceSlug="alpha" versions={[]} revalidatePathStr="/acme/alpha/docs/d1"
    />
  )
}
function mount(initial: Props) {
  const view = render(tree(initial))
  return { update: (next: Props) => view.rerender(tree(next)) }
}
const savedToken = (call: number) => (actions.updateDoc.mock.calls[call] as unknown[])[3]
const settle = () => new Promise((resolve) => setTimeout(resolve, 1600))
/** A user edit through the real UI: rename the canvas, which saves through the same queue. */
async function userEditsTitle() {
  const input = screen.getByLabelText("Canvas title")
  fireEvent.change(input, { target: { value: "Board (mine)" } })
  fireEvent.blur(input)
}

describe("CanvasDocEditor live refresh", () => {
  it("polls this doc's change token", () => {
    mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    expect(useLiveRefresh).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme", workspaceSlug: "alpha", scope: "doc:d1" }))
  })

  it("a clean editor adopts the new canvas, flags the update, and does not save it", async () => {
    const { update } = mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    update({ revision: "rev-2", canvas: canvasOf({ id: "a", text: "A", x: 400 }, { id: "b", text: "Added by agent" }) })
    expect(await screen.findByTestId("doc-updated-just-now")).toBeInTheDocument()
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
    await waitFor(() => expect(document.body.textContent).toContain("Added by agent"))
    await settle()
    expect(actions.updateDoc).not.toHaveBeenCalled()
  })

  it("undo history does not reach back across an adopted remote edit", async () => {
    const { update } = mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    update({ revision: "rev-2", canvas: canvasOf({ id: "a", text: "A" }, { id: "b", text: "Remote" }) })
    await screen.findByTestId("doc-updated-just-now")
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
  })

  it("a clean editor's next save is based on the adopted revision and carries the remote nodes", async () => {
    const { update } = mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    update({ revision: "rev-2", canvas: canvasOf({ id: "a", text: "A" }, { id: "b", text: "Remote" }) })
    await screen.findByTestId("doc-updated-just-now")
    await userEditsTitle()
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(1))
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-2" })
  })

  it("unsaved work blocks adoption and shows the banner; Keep mine re-bases the save", async () => {
    const { update } = mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    // Pending work: a title save that fails keeps the queue dirty (parked), as a revision conflict would.
    actions.updateDoc.mockRejectedValueOnce(Object.assign(new Error("revision-conflict"), { code: "revision-conflict" }))
    await userEditsTitle()
    await screen.findByText(/Changes could not be saved/)
    update({ revision: "rev-2", canvas: canvasOf({ id: "a", text: "A" }, { id: "b", text: "Remote" }), name: "Ada", source: "UI" })
    expect(await screen.findByTestId("remote-update-banner")).toHaveTextContent("Updated by Ada")
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull()
    expect(document.body.textContent).not.toContain("Remote")
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }))
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(2))
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-1" })
    expect(savedToken(1)).toMatchObject({ expectedRevision: "rev-2" })
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
  })

  it("Reload discards the parked draft, adopts the remote canvas, and saves nothing", async () => {
    const { update } = mount({ revision: "rev-1", canvas: canvasOf({ id: "a", text: "A" }) })
    actions.updateDoc.mockRejectedValueOnce(Object.assign(new Error("revision-conflict"), { code: "revision-conflict" }))
    await userEditsTitle()
    await screen.findByText(/Changes could not be saved/)
    update({ revision: "rev-2", canvas: canvasOf({ id: "a", text: "A" }, { id: "b", text: "Remote" }) })
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }))
    await waitFor(() => expect(document.body.textContent).toContain("Remote"))
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
    expect(screen.queryByText(/Changes could not be saved/)).toBeNull()
    await settle()
    expect(actions.updateDoc).toHaveBeenCalledTimes(1) // only the original failed attempt
  })
})
