// @vitest-environment jsdom
/**
 * Live refresh inside the real DocEditor: a server render carrying a newer revision (an agent or another tab wrote the doc).
 * A clean editor adopts it silently; an editor with unsaved work keeps the draft and asks; neither may ever save the adopted text.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/react"

const actions = vi.hoisted(() => {
  const none = async () => ({})
  return {
    updateDoc: vi.fn(async (..._args: unknown[]) => ({ revision: "rev-saved" })),
    resolveDocEmbedRefs: vi.fn(async () => ({ cards: {}, deferred: [] })),
    createDocVersion: none, addDocCommentWithTask: none, resolveDocComment: none, deleteDocComment: none, getDocLinkedTasks: none, restoreDocVersion: none,
  }
})
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => actions)
vi.mock("@/auth", () => ({ auth: () => undefined }))
vi.mock("@/lib/db", () => ({ default: () => undefined }))
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { DocEditor } from "@/components/docs/doc-editor"
import type { DocCommentItem } from "@/components/docs/doc-comments-sidebar"
import { useLiveRefresh } from "@/hooks/use-live-refresh"

afterEach(() => {
  cleanup()
  actions.updateDoc.mockReset()
  actions.updateDoc.mockImplementation(async () => ({ revision: "rev-saved" }))
})

type Props = { revision: string; content: string; title?: string; comments?: DocCommentItem[]; source?: string; name?: string | null }
function tree({ revision, content, title = "Doc", comments = [], source = "MCP", name = null }: Props) {
  return (
    <DocEditor
      doc={{ id: "d1", title, content, icon: null, revision, metadata: null }}
      lastWriter={{ name, source }}
      versions={[]} comments={comments} revalidatePathStr="/acme/alpha/docs/d1" orgSlug="acme" workspaceSlug="alpha" workspaceId="w1"
      linkedTasks={{ deliveryTasks: [], linkableTasks: [], members: [] }}
    />
  )
}
async function mount(initial: Props) {
  const view = render(tree(initial))
  await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull())
  const editor = (document.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor
  return { editor, update: (next: Props) => view.rerender(tree(next)) }
}
const text = () => document.querySelector(".ProseMirror")?.textContent ?? ""
const settle = () => new Promise((resolve) => setTimeout(resolve, 1600))
const savedToken = (call: number) => (actions.updateDoc.mock.calls[call] as unknown[])[3]

describe("DocEditor live refresh", () => {
  it("polls this doc's change token", () => {
    render(tree({ revision: "rev-1", content: "Hello" }))
    expect(useLiveRefresh).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme", workspaceSlug: "alpha", scope: "doc:d1" }))
  })

  it("a clean editor adopts the newer content silently, shows the indicator, and never saves it", async () => {
    const { update } = await mount({ revision: "rev-1", content: "Hello" })
    // Ends in a heading on purpose: TrailingNode must not turn the adopted text into a "user edit".
    update({ revision: "rev-2", content: "# Agent wrote this\n\n## Open questions\n" })
    await waitFor(() => expect(text()).toContain("Agent wrote this"))
    expect(screen.getByTestId("doc-updated-just-now")).toBeInTheDocument()
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
    await settle()
    expect(actions.updateDoc).not.toHaveBeenCalled()
  })

  it("a clean editor's next save is based on the adopted revision", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    update({ revision: "rev-2", content: "Hello from the agent" })
    await waitFor(() => expect(text()).toContain("from the agent"))
    act(() => { editor.commands.insertContent(" and me") })
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-2" })
  })

  it("our own save coming back through a refresh is not news", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" there") })
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(1), { timeout: 3000 })
    update({ revision: "rev-saved", content: "Hello there" })
    await settle()
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
    expect(screen.queryByTestId("doc-updated-just-now")).toBeNull()
    expect(actions.updateDoc).toHaveBeenCalledTimes(1)
  })

  it("an editor with unsaved work keeps its draft and shows who changed the doc", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    update({ revision: "rev-2", content: "Agent version", name: "Ada" , source: "UI" })
    expect(await screen.findByTestId("remote-update-banner")).toHaveTextContent("Updated by Ada")
    expect(text()).toContain("my draft")
    expect(text()).not.toContain("Agent version")
  })

  it("names an agent write that has no user, and falls back to 'an agent'", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    update({ revision: "rev-2", content: "Agent version" })
    expect(await screen.findByTestId("remote-update-banner")).toHaveTextContent("Updated by an agent")
    expect(editor.isDestroyed).toBe(false)
  })

  it("Keep mine re-bases the save on the new revision so it overwrites knowingly", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    update({ revision: "rev-2", content: "Agent version" })
    fireEvent.click(await screen.findByRole("button", { name: "Keep mine" }))
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-2" })
    expect((actions.updateDoc.mock.calls[0] as unknown[])[1]).toMatchObject({ content: expect.stringContaining("my draft") })
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
  })

  it("Keep mine resolves a stuck revision-conflict Retry instead of replaying the stale token", async () => {
    actions.updateDoc.mockRejectedValueOnce(Object.assign(new Error("revision-conflict"), { code: "revision-conflict" }))
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    await screen.findByText(/Changes could not be saved/, undefined, { timeout: 3000 })
    update({ revision: "rev-2", content: "Agent version" })
    // The conflict message and its Retry are replaced by the banner: retrying with the stale token can never succeed.
    await screen.findByTestId("remote-update-banner")
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }))
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(2))
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-1" })
    expect(savedToken(1)).toMatchObject({ expectedRevision: "rev-2" })
    await waitFor(() => expect(screen.queryByText(/Changes could not be saved/)).toBeNull())
  })

  it("Reload discards the draft, adopts the remote text without saving, and bases later saves on the new revision", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    update({ revision: "rev-2", content: "Agent version" })
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }))
    await waitFor(() => expect(text()).toContain("Agent version"))
    expect(text()).not.toContain("my draft")
    await settle()
    expect(actions.updateDoc).not.toHaveBeenCalled() // the discarded draft's debounce never fires, the adopted text is not an edit
    act(() => { editor.commands.insertContent("!") })
    await waitFor(() => expect(actions.updateDoc).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(savedToken(0)).toMatchObject({ expectedRevision: "rev-2" })
  })

  it("comments update from a refresh even while the editor holds a draft", async () => {
    const { editor, update } = await mount({ revision: "rev-1", content: "Hello" })
    act(() => { editor.commands.insertContent(" my draft") })
    const comment: DocCommentItem = {
      id: "c1", parentId: null, body: "Agent comment", status: "OPEN", anchorText: "Hello", anchorStart: 0, anchorEnd: 5,
      anchorPrefix: "", anchorSuffix: " my draft", authorName: "Agent", authorType: "AGENT", createdAt: new Date("2026-01-01"),
    }
    // Same revision: comments do not bump Doc.revision, so this refresh must apply on its own.
    update({ revision: "rev-1", content: "Hello", comments: [comment] })
    const toolbarButton = screen.getByTitle("Comments")
    await waitFor(() => expect(toolbarButton).toHaveTextContent("1"))
    expect(screen.queryByTestId("remote-update-banner")).toBeNull()
    expect(text()).toContain("my draft")
    update({ revision: "rev-1", content: "Hello", comments: [{ ...comment, status: "RESOLVED" }] })
    await waitFor(() => expect(toolbarButton).not.toHaveTextContent("1"))
  })
})
