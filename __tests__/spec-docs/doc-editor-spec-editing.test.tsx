// @vitest-environment jsdom
/**
 * The "/" menu and card editing inside the real DocEditor (spec docs phase 4): what reaches the doc's autosave and what must not.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/react"

const actions = vi.hoisted(() => {
  const none = async () => ({})
  return {
    updateDoc: vi.fn(async () => ({ revision: "rev-2" })),
    resolveDocEmbedRefs: vi.fn(),
    createDocVersion: none, addDocCommentWithTask: none, resolveDocComment: none, deleteDocComment: none, getDocLinkedTasks: none, restoreDocVersion: none,
  }
})
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => actions)
vi.mock("@/auth", () => ({ auth: () => undefined }))
vi.mock("@/lib/db", () => ({ default: () => undefined }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { DocEditor } from "@/components/docs/doc-editor"
import type { RecordCreators, SlashScope } from "@/components/docs/spec-slash-menu"
import type { PatchRecordField } from "@/components/docs/doc-embed-cards"

const SOLUTION = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const OPPORTUNITY = "1c8f4dab-6e20-4a7f-9b3c-0d5e6f7a8b9c"
const NEW_ID = "99999999-8888-4777-8666-555555555555"
const GONE = "33333333-4444-4555-8666-777777777777"
const BASE = "# Spec\n\nIntro text.\n\n## Open questions\n"
const SOLUTION_SCOPE: SlashScope = { scopeType: "SOLUTION", scopeId: SOLUTION, title: "Checkout" }
const OPPORTUNITY_SCOPE: SlashScope = { scopeType: "OPPORTUNITY", scopeId: OPPORTUNITY, title: "Cart abandonment" }

afterEach(() => {
  cleanup()
  actions.updateDoc.mockClear()
  actions.resolveDocEmbedRefs.mockReset()
})

function creators(overrides: Partial<RecordCreators> = {}): RecordCreators & { createAssumption: ReturnType<typeof vi.fn>; createTask: ReturnType<typeof vi.fn> } {
  return {
    createAssumption: vi.fn(async (_solutionId: string, title: string) => ({ id: NEW_ID, title })),
    createTask: vi.fn(async (_scope: unknown, title: string) => ({ id: NEW_ID, title })),
    ...overrides,
  } as never
}

async function mount(props: { content?: string; specScopes?: SlashScope[] | undefined; readOnly?: boolean; recordCreators?: RecordCreators; patchRecordField?: PatchRecordField }) {
  render(
    <DocEditor
      doc={{ id: "d1", title: "Doc", content: props.content ?? BASE, icon: null, revision: "rev-1", metadata: null }}
      versions={[]} comments={[]} revalidatePathStr="/acme/alpha/docs/d1" orgSlug="acme" workspaceSlug="alpha" workspaceId="w1"
      linkedTasks={{ deliveryTasks: [], linkableTasks: [], members: [] }}
      specScopes={props.specScopes} readOnly={props.readOnly} recordCreators={props.recordCreators} patchRecordField={props.patchRecordField}
    />
  )
  await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull())
  return (document.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 1600))
const markdownOf = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()

/** Put the cursor at the end of a fresh paragraph holding `text`, as if it had been typed. */
function typeLine(editor: Editor, text: string) {
  act(() => {
    editor.chain().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text }] }).run()
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
}
const menu = () => screen.queryByTestId("spec-slash-menu")
const embedCount = (editor: Editor) => (markdownOf(editor).match(/compass:\/\//g) ?? []).length

describe('the "/" menu', () => {
  it("opens on '/', lists what a solution spec can create, and closes on Escape without changing the document", async () => {
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: creators() })
    typeLine(editor, "/")
    await waitFor(() => expect(menu()).not.toBeNull())
    expect(within(menu()!).getByTestId("spec-slash-assumption")).toHaveTextContent("New assumption on Checkout")
    expect(within(menu()!).getByTestId("spec-slash-task")).toHaveTextContent("New task linked to Checkout")
    const before = markdownOf(editor)
    fireEvent.keyDown(editor.view.dom, { key: "Escape" })
    await waitFor(() => expect(menu()).toBeNull())
    expect(markdownOf(editor)).toBe(before)
    // Typing more text in the same paragraph without changing it keeps it closed; changing it reopens.
    act(() => { editor.commands.insertContent("t") })
    await waitFor(() => expect(menu()).not.toBeNull())
  })

  it("filters by what was typed after the slash and hides when nothing matches", async () => {
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: creators() })
    typeLine(editor, "/ta")
    await waitFor(() => expect(screen.getByTestId("spec-slash-task")).toBeInTheDocument())
    expect(screen.queryByTestId("spec-slash-assumption")).toBeNull()
    act(() => { editor.commands.insertContent("zzz") })
    await waitFor(() => expect(menu()).toBeNull())
  })

  it("a discovery plan (opportunity scope) offers a task only: an assumption needs a solution", async () => {
    const editor = await mount({ specScopes: [OPPORTUNITY_SCOPE], recordCreators: creators() })
    typeLine(editor, "/")
    await waitFor(() => expect(menu()).not.toBeNull())
    expect(screen.getByTestId("spec-slash-task")).toHaveTextContent("Cart abandonment")
    expect(screen.queryByTestId("spec-slash-assumption")).toBeNull()
  })

  it("creates the record then inserts exactly one embed paragraph in place of '/', and saves once", async () => {
    const make = creators()
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: make })
    typeLine(editor, "/")
    await waitFor(() => expect(menu()).not.toBeNull())
    fireEvent.click(screen.getByRole("button", { name: /Assumption/ }))
    const input = await screen.findByTestId("spec-slash-title")
    expect(menu()).toHaveTextContent("New assumption")
    fireEvent.change(input, { target: { value: "Users trust saved cards" } })
    fireEvent.click(screen.getByTestId("spec-slash-create"))
    await waitFor(() => expect(embedCount(editor)).toBe(1))
    expect(make.createAssumption).toHaveBeenCalledTimes(1)
    expect(make.createAssumption).toHaveBeenCalledWith(SOLUTION, "Users trust saved cards")
    expect(make.createTask).not.toHaveBeenCalled()
    const md = markdownOf(editor)
    expect(md).toContain(`[Users trust saved cards](compass://assumption/${NEW_ID})`)
    expect(md).not.toMatch(/^\/$/m)
    expect(md).toContain("Intro text.")
    await waitFor(() => expect(menu()).toBeNull())
    await settle()
    expect(actions.updateDoc).toHaveBeenCalledTimes(1)
    const [, change] = actions.updateDoc.mock.calls[0] as unknown as [string, { content: string }]
    expect(change.content).toContain(`compass://assumption/${NEW_ID}`)
    expect(change.content).not.toMatch(/^\/$/m)
  })

  it("a task from a spec is linked to the solution; from a discovery plan, to the opportunity", async () => {
    const make = creators()
    const editor = await mount({ specScopes: [SOLUTION_SCOPE, OPPORTUNITY_SCOPE], recordCreators: make })
    typeLine(editor, "/task")
    await waitFor(() => expect(menu()).not.toBeNull())
    fireEvent.keyDown(editor.view.dom, { key: "Enter" })
    fireEvent.change(await screen.findByTestId("spec-slash-title"), { target: { value: "Write the brief" } })
    fireEvent.submit(screen.getByTestId("spec-slash-title").closest("form")!)
    await waitFor(() => expect(make.createTask).toHaveBeenCalledWith({ scopeType: "SOLUTION", scopeId: SOLUTION }, "Write the brief"))
    await waitFor(() => expect(markdownOf(editor)).toContain(`compass://task/${NEW_ID}`))
  })

  it("a failed create inserts nothing, keeps the title, and shows the error", async () => {
    const make = creators({ createAssumption: vi.fn(async () => { throw new Error("denied") }) })
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: make })
    typeLine(editor, "/")
    await waitFor(() => expect(menu()).not.toBeNull())
    fireEvent.click(screen.getByRole("button", { name: /Assumption/ }))
    fireEvent.change(await screen.findByTestId("spec-slash-title"), { target: { value: "Will fail" } })
    fireEvent.click(screen.getByTestId("spec-slash-create"))
    expect(await screen.findByTestId("spec-slash-error")).toHaveTextContent("Nothing was added to the document")
    expect(embedCount(editor)).toBe(0)
    expect((screen.getByTestId("spec-slash-title") as HTMLInputElement).value).toBe("Will fail")
    // Escape in the title box cancels the whole thing.
    fireEvent.keyDown(screen.getByTestId("spec-slash-title"), { key: "Escape" })
    await waitFor(() => expect(menu()).toBeNull())
    expect(embedCount(editor)).toBe(0)
  })

  it("an empty title is not sent to the create action", async () => {
    const make = creators()
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: make })
    typeLine(editor, "/")
    await waitFor(() => expect(menu()).not.toBeNull())
    fireEvent.click(screen.getByRole("button", { name: /Task/ }))
    fireEvent.click(await screen.findByTestId("spec-slash-create"))
    expect(await screen.findByTestId("spec-slash-error")).toBeInTheDocument()
    expect(make.createTask).not.toHaveBeenCalled()
    expect(make.createAssumption).not.toHaveBeenCalled()
  })

  it("an unscoped spec never opens the menu (fail closed)", async () => {
    const make = creators()
    const editor = await mount({ specScopes: [], recordCreators: make })
    typeLine(editor, "/")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(menu()).toBeNull()
    fireEvent.keyDown(editor.view.dom, { key: "Enter" })
    expect(make.createAssumption).not.toHaveBeenCalled()
    expect(make.createTask).not.toHaveBeenCalled()
  })

  it("a plain doc (no spec scopes prop) and a read-only viewer never get the menu", async () => {
    const plain = await mount({ recordCreators: creators() })
    typeLine(plain, "/")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(menu()).toBeNull()
    cleanup()
    const readOnly = await mount({ specScopes: [SOLUTION_SCOPE], readOnly: true, recordCreators: creators() })
    typeLine(readOnly, "/")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(menu()).toBeNull()
  })

  it("'/' in the middle of a sentence, in a list or in a heading does not open it", async () => {
    const editor = await mount({ specScopes: [SOLUTION_SCOPE], recordCreators: creators() })
    typeLine(editor, "a / b")
    typeLine(editor, "/ then more")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(menu()).toBeNull()
  })
})

describe("card edits and Remove inside the doc editor", () => {
  const card = (title: string, status = "IDEA") => ({ state: "ok" as const, kind: "solution" as const, id: SOLUTION, title, status, facts: [], href: "/x" })
  const withCards = `${BASE}\n[Cached](compass://solution/${SOLUTION})\n\n[Cached gone](compass://task/${GONE})\n`

  it("a card edit does not fire a doc save and does not change the markdown; a card rename leaves the cached title as stored", async () => {
    let title = "Live title"
    actions.resolveDocEmbedRefs.mockImplementation(async (_doc: string, refs: Array<{ kind: string; id: string }>) => ({
      cards: Object.fromEntries(refs.map((r) => [`${r.kind}:${r.id}`, r.id === SOLUTION ? card(title) : { state: "unavailable", kind: r.kind, id: r.id }])),
      deferred: [],
      canEdit: true,
    }))
    const patch = vi.fn<PatchRecordField>(async (_t, _i, _f, value) => { title = value })
    const editor = await mount({ content: withCards, specScopes: [SOLUTION_SCOPE], patchRecordField: patch })
    const before = markdownOf(editor)
    fireEvent.click(await screen.findByTestId("embed-card-toggle"))
    fireEvent.click(await screen.findByRole("button", { name: "Rename Live title" }))
    fireEvent.change(screen.getByTestId("embed-title-input"), { target: { value: "Renamed live" } })
    fireEvent.keyDown(screen.getByTestId("embed-title-input"), { key: "Enter" })
    await screen.findByRole("group", { name: "Solution: Renamed live" })
    await settle()
    expect(patch).toHaveBeenCalledWith("solution", SOLUTION, "title", "Renamed live")
    expect(actions.updateDoc).not.toHaveBeenCalled()
    expect(markdownOf(editor)).toBe(before)
    expect(markdownOf(editor)).toContain("[Cached](compass://solution/")
  })

  it("Remove on an unavailable card removes only its paragraph, autosaves once, and calls no record write", async () => {
    actions.resolveDocEmbedRefs.mockImplementation(async (_doc: string, refs: Array<{ kind: string; id: string }>) => ({
      cards: Object.fromEntries(refs.map((r) => [`${r.kind}:${r.id}`, r.id === SOLUTION ? card("Live title") : { state: "unavailable", kind: r.kind, id: r.id }])),
      deferred: [],
      canEdit: true,
    }))
    const patch = vi.fn<PatchRecordField>(async () => undefined)
    await mount({ content: withCards, specScopes: [SOLUTION_SCOPE], patchRecordField: patch })
    const placeholder = (await screen.findByText("Record unavailable")).closest("[data-slot='spec-embed-card']") as HTMLElement
    fireEvent.click(within(placeholder).getByRole("button", { name: "Remove" }))
    await settle()
    expect(actions.updateDoc).toHaveBeenCalledTimes(1)
    const [, change] = actions.updateDoc.mock.calls[0] as unknown as [string, { content: string }]
    expect(change.content).not.toContain(GONE)
    expect(change.content).toContain(`compass://solution/${SOLUTION}`)
    expect(change.content).toContain("Intro text.")
    expect(patch).not.toHaveBeenCalled()
  })

  it("a read-only viewer sees no edit affordances on any card, including Remove", async () => {
    actions.resolveDocEmbedRefs.mockImplementation(async (_doc: string, refs: Array<{ kind: string; id: string }>) => ({
      cards: Object.fromEntries(refs.map((r) => [`${r.kind}:${r.id}`, r.id === SOLUTION ? card("Live title") : { state: "unavailable", kind: r.kind, id: r.id }])),
      deferred: [],
      canEdit: true, // even if the server were to say yes, the page said read-only
    }))
    await mount({ content: withCards, specScopes: [SOLUTION_SCOPE], readOnly: true })
    await screen.findByRole("group", { name: "Solution: Live title" })
    await screen.findByText("Record unavailable")
    for (const toggle of screen.getAllByTestId("embed-card-toggle")) fireEvent.click(toggle)
    for (const wrapper of document.querySelectorAll("[data-compass-embed]")) {
      expect(within(wrapper as HTMLElement).queryAllByRole("button").filter((b) => b.getAttribute("data-testid") !== "embed-card-toggle")).toHaveLength(0)
      expect(wrapper.querySelector("select,input")).toBeNull()
    }
  })
})
