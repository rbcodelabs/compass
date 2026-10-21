// @vitest-environment jsdom
/**
 * The read-only embed card (spec docs phase 3): its states, the editor node view that mounts it, and the guarantees that matter more than
 * the pixels: the cached markdown title is never displayed, the markdown is byte-for-byte unchanged by the node view, a batch of cards is
 * one server call, and the plain-text projection used for comment anchors does not depend on live card data.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor, EditorContent } from "@tiptap/react"
import type { MarkdownStorage } from "tiptap-markdown"
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions"
import { DocEmbedCardsProvider, type EmbedEntry, type EmbedResolver } from "@/components/docs/doc-embed-cards"
import { SpecEmbedCard, safeInternalHref } from "@/components/docs/spec-embed-card"
import { projectDocText } from "@/components/docs/comment-highlight-extension"
import { resolveCommentAnchor } from "@/lib/comment-anchor"
import type { DocEmbedCardView } from "@/lib/canvas-card-data"

afterEach(cleanup)

const ID1 = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const ID2 = "11111111-2222-4333-8444-555555555555"
const ready = (card: DocEmbedCardView): EmbedEntry => ({ status: "ready", card })
const okCard = (extra: Partial<Extract<DocEmbedCardView, { state: "ok" }>> = {}): DocEmbedCardView => ({
  state: "ok", kind: "solution", id: ID1, title: "Live checkout", status: "IN_PROGRESS", facts: [{ label: "Score", value: "82%" }, { label: "Opportunity", value: "Drop-off" }], href: "/acme/alpha/discovery/opp-1", ...extra,
})

describe("SpecEmbedCard states", () => {
  it("ok: live title as a link, humanized status and key facts", () => {
    render(<SpecEmbedCard kind="solution" entry={ready(okCard())} />)
    const link = screen.getByRole("link", { name: "Live checkout" })
    expect(link).toHaveAttribute("href", "/acme/alpha/discovery/opp-1")
    expect(screen.getByText("Solution")).toBeInTheDocument()
    expect(screen.getByText("In progress")).toBeInTheDocument()
    expect(screen.getByText("Score")).toBeInTheDocument()
    expect(screen.getByText("82%")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Solution: Live checkout" })).toBeInTheDocument()
  })

  it("ok: a card with no status and no facts is just kind and title", () => {
    const { container } = render(<SpecEmbedCard kind="keyResult" entry={ready(okCard({ kind: "keyResult", status: null, facts: [] }))} />)
    expect(container.querySelector("dl")).toBeNull()
    expect(screen.getByText("Key result")).toBeInTheDocument()
  })

  it("ok: a non-internal href is not rendered as a link", () => {
    expect(safeInternalHref("/a/b")).toBe("/a/b")
    for (const bad of ["https://evil.test", "//evil.test", "javascript:alert(1)", "\\\\evil"]) expect(safeInternalHref(bad)).toBeNull()
    render(<SpecEmbedCard kind="task" entry={ready(okCard({ kind: "task", href: "javascript:alert(1)" }))} />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("Live checkout")).toBeInTheDocument()
  })

  it("unavailable: 'Record unavailable' with no link and no edit action", () => {
    const { container } = render(<SpecEmbedCard kind="task" entry={ready({ state: "unavailable", kind: "task", id: ID1 })} />)
    expect(screen.getByText("Record unavailable")).toBeInTheDocument()
    expect(container.querySelector('[data-state="unavailable"]')).not.toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("loading: busy placeholder with the kind only", () => {
    const { container } = render(<SpecEmbedCard kind="metric" entry={undefined} />)
    expect(container.querySelector('[data-state="loading"]')).toHaveAttribute("aria-busy", "true")
    expect(screen.getByText("Metric")).toBeInTheDocument()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("error: says it could not load and offers nothing to edit", () => {
    render(<SpecEmbedCard kind="doc" entry={{ status: "error" }} />)
    expect(screen.getByText(/could not load/i)).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })
})

const markdownOf = (editor: Editor) => (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()
const link = (title: string, kind: string, id: string) => `[${title}](compass://${kind}/${id})`
const DOC = `# Spec\n\nBefore the cards.\n\n${link("Stale cached title", "solution", ID1)}\n\n${link("Old task name", "task", ID2)}\n\nAfter the cards.`

function mountEditor(resolve: EmbedResolver | null, content = DOC) {
  const editor = new Editor({ extensions: createDocEditorExtensions([]), content })
  render(
    resolve ? (
      <DocEmbedCardsProvider resolve={resolve}>
        <EditorContent editor={editor} />
      </DocEmbedCardsProvider>
    ) : (
      <EditorContent editor={editor} />
    )
  )
  return editor
}

const answer = (cards: DocEmbedCardView[]) => ({ cards: Object.fromEntries(cards.map((c) => [`${c.kind}:${c.id}`, c])), deferred: [] })

describe("SpecEmbed node view in the editor", () => {
  it("renders the live title and facts, never the cached markdown title, and asks the server once for the whole batch", async () => {
    const resolve = vi.fn<EmbedResolver>(async () =>
      answer([okCard(), { state: "ok", kind: "task", id: ID2, title: "Live task", status: "TODO", facts: [], href: "/acme/alpha/tasks/t1" }])
    )
    const editor = mountEditor(resolve)
    expect(await screen.findByRole("link", { name: "Live checkout" })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: "Live task" })).toBeInTheDocument()
    expect(screen.queryByText("Stale cached title")).toBeNull()
    expect(screen.queryByText("Old task name")).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toHaveLength(2)
    expect(resolve.mock.calls[0][0]).toEqual(expect.arrayContaining([{ kind: "solution", id: ID1 }, { kind: "task", id: ID2 }]))
    editor.destroy()
  })

  it("shows the loading state until the answer arrives, then the unavailable state", async () => {
    let finish!: (value: ReturnType<typeof answer>) => void
    const resolve = vi.fn<EmbedResolver>(() => new Promise((r) => { finish = r }))
    const editor = mountEditor(resolve, link("Gone", "solution", ID1))
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    expect(document.querySelector('[data-state="loading"]')).not.toBeNull()
    await act(async () => finish(answer([{ state: "unavailable", kind: "solution", id: ID1 }])))
    expect(await screen.findByText("Record unavailable")).toBeInTheDocument()
    expect(document.querySelector('[data-state="loading"]')).toBeNull()
    expect(screen.queryByText("Gone")).toBeNull()
    editor.destroy()
  })

  it("a failing server call leaves the card in the error state and does not touch the document", async () => {
    const resolve = vi.fn<EmbedResolver>(async () => { throw new Error("boom") })
    const editor = mountEditor(resolve)
    expect((await screen.findAllByText(/could not load/i)).length).toBe(2)
    expect(markdownOf(editor)).toBe(DOC)
    editor.destroy()
  })

  it("without a provider the cards stay in the loading state and nothing throws", async () => {
    const editor = mountEditor(null)
    await waitFor(() => expect(document.querySelectorAll('[data-state="loading"]').length).toBe(2))
    editor.destroy()
  })

  it("markdown serialization is byte-for-byte unchanged with the node view mounted, before and after the cards load", async () => {
    const resolve = vi.fn<EmbedResolver>(async () => answer([okCard(), { state: "unavailable", kind: "task", id: ID2 }]))
    const withoutView = new Editor({ extensions: createDocEditorExtensions([]), content: DOC })
    const baseline = markdownOf(withoutView)
    withoutView.destroy()
    const editor = mountEditor(resolve)
    expect(markdownOf(editor)).toBe(baseline)
    await screen.findByRole("link", { name: "Live checkout" })
    expect(markdownOf(editor)).toBe(baseline)
    expect(markdownOf(editor)).toBe(DOC)
    editor.destroy()
  })

  it("rendering cards never edits the document (no transaction, no update event)", async () => {
    const resolve = vi.fn<EmbedResolver>(async () => answer([okCard(), { state: "unavailable", kind: "task", id: ID2 }]))
    const editor = new Editor({ extensions: createDocEditorExtensions([]), content: DOC })
    const onUpdate = vi.fn()
    editor.on("update", onUpdate)
    const before = editor.state.doc
    render(
      <DocEmbedCardsProvider resolve={resolve}>
        <EditorContent editor={editor} />
      </DocEmbedCardsProvider>
    )
    await screen.findByRole("link", { name: "Live checkout" })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(editor.state.doc.eq(before)).toBe(true)
    editor.destroy()
  })

  it("the card is not editable text: no input, no button, and the wrapper is contenteditable=false", async () => {
    const editor = mountEditor(async () => answer([okCard(), { state: "unavailable", kind: "task", id: ID2 }]))
    await screen.findByRole("link", { name: "Live checkout" })
    const wrappers = document.querySelectorAll("[data-compass-embed]")
    expect(wrappers.length).toBe(2)
    for (const w of wrappers) {
      expect(w.getAttribute("contenteditable")).toBe("false")
      expect(within(w as HTMLElement).queryByRole("button")).toBeNull()
      expect(w.querySelector("input,textarea")).toBeNull()
    }
    editor.destroy()
  })
})

describe("comment anchors and embeds", () => {
  it("the plain-text projection is a function of the stored document alone: loading live data does not change it or the anchors", async () => {
    const resolve = vi.fn<EmbedResolver>(async () => answer([okCard({ title: "A much longer live title that is not in the markdown" }), { state: "unavailable", kind: "task", id: ID2 }]))
    const editor = mountEditor(resolve)
    const textOf = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n")
    const before = { text: textOf(), projected: projectDocText(editor.state.doc).text }
    await screen.findByRole("link", { name: /much longer live title/ })
    expect(textOf()).toBe(before.text)
    expect(projectDocText(editor.state.doc).text).toBe(before.projected)
    expect(before.text).not.toContain("much longer live title")

    // An anchor captured after the cards still resolves to the same words, before and after the live data arrived.
    const start = before.text.indexOf("After the cards.")
    const anchor = { anchorText: "After the cards.", anchorStart: start, anchorEnd: start + 16, anchorPrefix: null, anchorSuffix: null }
    expect(resolveCommentAnchor(before.text, anchor)).toEqual({ from: start, to: start + 16 })
    expect(resolveCommentAnchor(textOf(), anchor)).toEqual({ from: start, to: start + 16 })
    editor.destroy()
  })

  it("changing the cached title of an embed does not move any anchor that is not inside it", () => {
    const text = (title: string) => {
      const e = new Editor({ extensions: createDocEditorExtensions([]), content: `# Spec\n\nBefore.\n\n${link(title, "solution", ID1)}\n\nAfter the card.` })
      const t = e.state.doc.textBetween(0, e.state.doc.content.size, "\n", "\n")
      e.destroy()
      return t
    }
    expect(text("Short")).toBe(text("A completely different and much longer cached title"))
  })
})
