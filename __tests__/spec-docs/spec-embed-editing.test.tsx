// @vitest-environment jsdom
/**
 * Editable embed cards (spec docs phase 4).
 *
 * The guarantees that matter: a card edit writes the RECORD (through the injected patch, the same call the record's page makes) and never
 * the document; a failure reverts to the server's value; an empty title is never sent; the card is re-resolved from the server after a
 * write; a viewer who cannot write sees no controls at all; Remove deletes only the embed paragraph.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor, EditorContent } from "@tiptap/react"
import type { MarkdownStorage } from "tiptap-markdown"
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions"
import { DocEmbedCardsProvider, EmbedCardStore, type EmbedBatch, type EmbedResolver, type PatchRecordField } from "@/components/docs/doc-embed-cards"
import { SpecEmbedCard } from "@/components/docs/spec-embed-card"
import type { DocEmbedCardView } from "@/lib/canvas-card-data"

afterEach(cleanup)

const SOLUTION_ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const TASK_ID = "11111111-2222-4333-8444-555555555555"
const METRIC_ID = "22222222-3333-4444-8555-666666666666"
const GONE_ID = "33333333-4444-4555-8666-777777777777"

const link = (title: string, kind: string, id: string) => `[${title}](compass://${kind}/${id})`
const DOC = `# Spec\n\nBefore.\n\n${link("Cached solution", "solution", SOLUTION_ID)}\n\n${link("Cached task", "task", TASK_ID)}\n\n${link("Cached metric", "metric", METRIC_ID)}\n\n${link("Cached gone", "task", GONE_ID)}\n\nAfter.`
const markdownOf = (editor: Editor) => (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()

/** A tiny fake server: records live here, the resolver reads them, the patch writes them. */
function fakeServer(options: { canEdit?: boolean } = {}) {
  const records: Record<string, { kind: string; title: string; status: string | null }> = {
    [SOLUTION_ID]: { kind: "solution", title: "Live solution", status: "IDEA" },
    [TASK_ID]: { kind: "task", title: "Live task", status: "TODO" },
    [METRIC_ID]: { kind: "metric", title: "Live metric", status: "HEALTHY" },
  }
  const card = (kind: string, id: string): DocEmbedCardView => {
    const r = records[id]
    if (!r) return { state: "unavailable", kind: kind as never, id }
    return { state: "ok", kind: r.kind as never, id, title: r.title, status: r.status, facts: [], href: `/acme/alpha/x/${id}` }
  }
  const resolve = vi.fn<EmbedResolver>(async (refs): Promise<EmbedBatch> => ({
    cards: Object.fromEntries(refs.map((ref) => [`${ref.kind}:${ref.id}`, card(ref.kind, ref.id)])),
    deferred: [],
    canEdit: options.canEdit ?? true,
  }))
  const patch = vi.fn<PatchRecordField>(async (_type, id, field, value) => {
    records[id][field] = value
    return {}
  })
  return { records, resolve, patch }
}

function mount(server: ReturnType<typeof fakeServer>, editable = true) {
  const editor = new Editor({ extensions: createDocEditorExtensions([]), content: DOC })
  const onUpdate = vi.fn()
  editor.on("update", onUpdate)
  render(
    <DocEmbedCardsProvider resolve={server.resolve} editing={{ editable, patch: server.patch }}>
      <EditorContent editor={editor} />
    </DocEmbedCardsProvider>
  )
  return { editor, onUpdate }
}
const cardOf = (name: string) => screen.getByRole("group", { name })

/** Cards start compact; every interaction below needs the body. */
const expandAll = () => {
  for (const toggle of screen.queryAllByTestId("embed-card-toggle")) if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle)
}
/** Every button except the compact row's own expand/collapse toggle, which is always present. */
const controlButtons = (root: ParentNode = document.body) => within(root as HTMLElement).queryAllByRole("button").filter((b) => b.getAttribute("data-testid") !== "embed-card-toggle")

describe("editing a title from a card", () => {
  it("writes the record through the patch, re-resolves the card, shows the saved state, and leaves the document alone", async () => {
    const server = fakeServer()
    const { editor, onUpdate } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    const input = screen.getByTestId("embed-title-input")
    fireEvent.change(input, { target: { value: "  Renamed solution  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(server.patch).toHaveBeenCalledTimes(1))
    expect(server.patch).toHaveBeenCalledWith("solution", SOLUTION_ID, "title", "Renamed solution")
    expect(await screen.findByRole("group", { name: "Solution: Renamed solution" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("embed-save-state")).toHaveAttribute("data-state", "saved"))
    // Re-resolved by id from the server after the write (one initial batch + one single-card refresh).
    expect(server.resolve).toHaveBeenCalledTimes(2)
    expect(server.resolve.mock.calls[1][0]).toEqual([{ kind: "solution", id: SOLUTION_ID }])
    // The document never moved: no editor transaction, the cached title is exactly as stored.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(markdownOf(editor)).toBe(DOC)
    editor.destroy()
  })

  it("a failed write reverts to the server's title, shows an error, and sends nothing to the document", async () => {
    const server = fakeServer()
    server.patch.mockRejectedValueOnce(new Error("save failed"))
    const { editor, onUpdate } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    const input = screen.getByTestId("embed-title-input")
    fireEvent.change(input, { target: { value: "Will not stick" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByTestId("embed-save-error")).toHaveTextContent("Could not save the title")
    expect(screen.queryByTestId("embed-title-input")).toBeNull()
    expect(screen.getByRole("group", { name: "Solution: Live solution" })).toBeInTheDocument()
    expect(screen.queryByText("Will not stick")).toBeNull()
    expect(server.resolve).toHaveBeenCalledTimes(1) // nothing changed on the server, nothing to re-read
    expect(onUpdate).not.toHaveBeenCalled()
    expect(markdownOf(editor)).toBe(DOC)
    editor.destroy()
  })

  it.each([["empty", ""], ["whitespace", "   "], ["too long", "x".repeat(256)]])("rejects an %s title client-side and never sends it", async (_name, value) => {
    const server = fakeServer()
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    const input = screen.getByTestId("embed-title-input")
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(await screen.findByTestId("embed-title-error")).toBeInTheDocument()
    expect(server.patch).not.toHaveBeenCalled()
    editor.destroy()
  })

  it("Escape cancels without a write; an unchanged title is not written either", async () => {
    const server = fakeServer()
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    fireEvent.change(screen.getByTestId("embed-title-input"), { target: { value: "Typed then abandoned" } })
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Escape" })
    expect(screen.queryByTestId("embed-title-input")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Enter" })
    expect(server.patch).not.toHaveBeenCalled()
    editor.destroy()
  })

  it("when the write succeeded but the re-read failed it says so instead of showing stale data as fresh", async () => {
    const server = fakeServer()
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    server.resolve.mockRejectedValueOnce(new Error("offline"))
    fireEvent.click(screen.getByRole("button", { name: "Rename Live solution" }))
    fireEvent.change(screen.getByTestId("embed-title-input"), { target: { value: "Saved remotely" } })
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Enter" })
    expect(await screen.findByTestId("embed-save-error")).toHaveTextContent("Saved, but this card could not be refreshed")
    expect(server.patch).toHaveBeenCalledTimes(1)
    editor.destroy()
  })
})

describe("the status picker", () => {
  it("offers the kind's statuses, writes the pick, and shows the re-resolved value", async () => {
    const server = fakeServer()
    const { editor, onUpdate } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    const select = within(cardOf("Solution: Live solution")).getByTestId("embed-status-select") as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"])
    expect(select.value).toBe("IDEA")
    fireEvent.change(select, { target: { value: "VALIDATED" } })
    await waitFor(() => expect(server.patch).toHaveBeenCalledWith("solution", SOLUTION_ID, "status", "VALIDATED"))
    await waitFor(() => expect((within(cardOf("Solution: Live solution")).getByTestId("embed-status-select") as HTMLSelectElement).value).toBe("VALIDATED"))
    expect(onUpdate).not.toHaveBeenCalled()
    expect(markdownOf(editor)).toBe(DOC)
    editor.destroy()
  })

  it("a failed status write puts the select back on the server's value and shows an error", async () => {
    const server = fakeServer()
    server.patch.mockRejectedValueOnce(new Error("nope"))
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()
    const select = within(cardOf("Task: Live task")).getByTestId("embed-status-select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "DONE" } })
    expect(await screen.findByTestId("embed-save-error")).toHaveTextContent("Could not save the status")
    await waitFor(() => expect((within(cardOf("Task: Live task")).getByTestId("embed-status-select") as HTMLSelectElement).value).toBe("TODO"))
    editor.destroy()
  })

  it("a status the kind does not list (or a kind with no status control) stays a plain pill with no select", async () => {
    const server = fakeServer()
    server.records[SOLUTION_ID].status = "SOMETHING_NEW"
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    expect(within(cardOf("Solution: Live solution")).queryByTestId("embed-status-select")).toBeNull()
    expect(within(cardOf("Solution: Live solution")).getByText("Something new")).toBeInTheDocument()
    // Metrics have no simple edit: no rename, no select.
    const metric = cardOf("Metric: Live metric")
    expect(within(metric).queryByTestId("embed-status-select")).toBeNull()
    expect(within(metric).queryByTestId("embed-title-edit")).toBeNull()
    editor.destroy()
  })

  it("two quick edits to one card both land and the card ends on the server's latest values", async () => {
    const server = fakeServer()
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()
    const select = within(cardOf("Task: Live task")).getByTestId("embed-status-select")
    fireEvent.click(screen.getByRole("button", { name: "Rename Live task" }))
    fireEvent.change(screen.getByTestId("embed-title-input"), { target: { value: "Renamed task" } })
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Enter" })
    fireEvent.change(select, { target: { value: "IN_PROGRESS" } })
    const done = await screen.findByRole("group", { name: "Task: Renamed task" })
    await waitFor(() => expect((within(done).getByTestId("embed-status-select") as HTMLSelectElement).value).toBe("IN_PROGRESS"))
    expect(server.records[TASK_ID]).toMatchObject({ title: "Renamed task", status: "IN_PROGRESS" })
    editor.destroy()
  })
})

describe("save messages are per attempt, never stale", () => {
  it("fail title, then fail status: only the status message shows; then a success clears everything", async () => {
    const server = fakeServer()
    server.patch.mockRejectedValueOnce(new Error("title denied")).mockRejectedValueOnce(new Error("status denied"))
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()

    fireEvent.click(screen.getByRole("button", { name: "Rename Live task" }))
    fireEvent.change(screen.getByTestId("embed-title-input"), { target: { value: "Nope" } })
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Enter" })
    expect(await screen.findByTestId("embed-save-error")).toHaveTextContent("Could not save the title")

    fireEvent.change(within(cardOf("Task: Live task")).getByTestId("embed-status-select"), { target: { value: "DONE" } })
    await waitFor(() => expect(screen.getByTestId("embed-save-error")).toHaveTextContent("Could not save the status"))
    expect(screen.queryByText(/Could not save the title/)).toBeNull()
    expect(screen.getAllByTestId("embed-save-error")).toHaveLength(1)

    fireEvent.change(within(cardOf("Task: Live task")).getByTestId("embed-status-select"), { target: { value: "DONE" } })
    await waitFor(() => expect(screen.getByTestId("embed-save-state")).toHaveAttribute("data-state", "saved"))
    expect(screen.queryByTestId("embed-save-error")).toBeNull()
    editor.destroy()
  })

  it("a new attempt clears the previous error as soon as it starts", async () => {
    const server = fakeServer()
    let release!: () => void
    server.patch.mockRejectedValueOnce(new Error("x")).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}) }))
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()
    fireEvent.change(within(cardOf("Task: Live task")).getByTestId("embed-status-select"), { target: { value: "DONE" } })
    expect(await screen.findByTestId("embed-save-error")).toBeInTheDocument()
    fireEvent.change(within(cardOf("Task: Live task")).getByTestId("embed-status-select"), { target: { value: "DONE" } })
    await waitFor(() => expect(screen.getByTestId("embed-save-state")).toHaveAttribute("data-state", "saving"))
    expect(screen.queryByTestId("embed-save-error")).toBeNull()
    await act(async () => release())
    editor.destroy()
  })
})

describe("menus use an opaque surface", () => {
  it("the card overflow menu has a solid popover background, not the translucent overlay token or any alpha", async () => {
    const server = fakeServer()
    const { editor } = mount(server)
    const card = await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()
    fireEvent.click(within(card).getByTestId("embed-card-menu"))
    const cls = within(card).getByRole("menu").className
    expect(cls).toContain("bg-popover")
    expect(cls).not.toContain("surface-overlay")
    expect(cls).not.toMatch(/\bbg-[\w-]+\/\d+/)
    editor.destroy()
  })
})

describe("who sees controls", () => {
  it("the page says read-only: no buttons, no select, no input anywhere in any card", async () => {
    const server = fakeServer()
    const { editor } = mount(server, false)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    await screen.findByText("Record unavailable")
    expandAll()
    for (const wrapper of document.querySelectorAll("[data-compass-embed]")) {
      expect(controlButtons(wrapper as HTMLElement)).toHaveLength(0)
      expect(wrapper.querySelector("select,input,textarea")).toBeNull()
      for (const id of ["embed-card-menu", "embed-remove", "embed-title-edit", "embed-status-select"]) expect(within(wrapper as HTMLElement).queryByTestId(id)).toBeNull()
      expect(within(wrapper as HTMLElement).queryByRole("menu")).toBeNull()
    }
    editor.destroy()
  })

  it("the server says the viewer cannot write: no controls, even though the page is editable", async () => {
    const server = fakeServer({ canEdit: false })
    const { editor } = mount(server)
    await screen.findByRole("group", { name: "Solution: Live solution" })
    expandAll()
    expect(controlButtons()).toHaveLength(0)
    expect(document.querySelector("select,input")).toBeNull()
    editor.destroy()
  })

  it("controls fail closed while the first answer is pending and when the resolver says nothing about editing", async () => {
    const server = fakeServer()
    server.resolve.mockImplementation(async (refs) => ({ cards: Object.fromEntries(refs.map((r) => [`${r.kind}:${r.id}`, { state: "ok" as const, kind: r.kind, id: r.id, title: "T", status: null, facts: [], href: "/x" }])), deferred: [] }))
    const { editor } = mount(server)
    await screen.findAllByRole("group")
    expandAll()
    expect(controlButtons()).toHaveLength(0)
    editor.destroy()
  })

  it("presentational card with no controls given shows none", () => {
    render(<SpecEmbedCard kind="solution" defaultExpanded entry={{ status: "ready", card: { state: "ok", kind: "solution", id: SOLUTION_ID, title: "T", status: "IDEA", facts: [], href: "/x" } }} />)
    expect(controlButtons()).toHaveLength(0)
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})

describe("Remove", () => {
  it("on an unavailable card removes only that embed paragraph, as an ordinary edit, and never writes a record", async () => {
    const server = fakeServer()
    const { editor, onUpdate } = mount(server)
    const placeholder = (await screen.findByText("Record unavailable")).closest("[data-slot='spec-embed-card']") as HTMLElement
    fireEvent.click(within(placeholder).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(markdownOf(editor)).toBe(DOC.replace(`${link("Cached gone", "task", GONE_ID)}\n\n`, ""))
    expect(markdownOf(editor)).toContain("Before.")
    expect(markdownOf(editor)).toContain("After.")
    expect(markdownOf(editor)).toContain(SOLUTION_ID)
    expect(server.patch).not.toHaveBeenCalled()
    editor.destroy()
  })

  it("on a resolved card it lives behind the overflow menu, says the record is not deleted, and closes on Escape", async () => {
    const server = fakeServer()
    const { editor, onUpdate } = mount(server)
    const card = await screen.findByRole("group", { name: "Task: Live task" })
    expandAll()
    fireEvent.click(within(card).getByTestId("embed-card-menu"))
    expect(within(card).getByRole("menu")).toHaveTextContent("The record is not deleted")
    fireEvent.keyDown(within(card).getByRole("menu"), { key: "Escape" })
    expect(within(card).queryByRole("menu")).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByTestId("embed-card-menu"))
    fireEvent.click(within(card).getByRole("menuitem", { name: "Remove from document" }))
    await waitFor(() => expect(markdownOf(editor)).not.toContain(TASK_ID))
    expect(markdownOf(editor)).toContain(SOLUTION_ID)
    expect(server.patch).not.toHaveBeenCalled()
    editor.destroy()
  })
})

describe("EmbedCardStore.refresh", () => {
  it("the newest refresh wins when an older one answers late", async () => {
    const ref = { kind: "task" as const, id: TASK_ID }
    const answers: Array<(batch: EmbedBatch) => void> = []
    const resolver: EmbedResolver = () => new Promise<EmbedBatch>((resolve) => answers.push(resolve))
    const store = new EmbedCardStore(resolver)
    const card = (title: string): EmbedBatch => ({ cards: { [`task:${TASK_ID}`]: { state: "ok", kind: "task", id: TASK_ID, title, status: null, facts: [], href: "/x" } }, deferred: [], canEdit: true })
    const first = store.refresh(ref)
    const second = store.refresh(ref)
    await act(async () => { answers[1](card("newer")); await second })
    await act(async () => { answers[0](card("older")); await first })
    expect(store.get(ref)).toEqual({ status: "ready", card: expect.objectContaining({ title: "newer" }) })
  })
})
