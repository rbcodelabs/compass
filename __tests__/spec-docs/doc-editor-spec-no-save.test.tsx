// @vitest-environment jsdom
/**
 * Regression: viewing a Spec or Discovery Plan must not save it.
 *
 * Root cause: the doc editor runs StarterKit's TrailingNode, which appends an empty paragraph to any document that does not end in a
 * paragraph. Every spec template ends in a heading ("## Decision log" / "## Open questions"), so the first ordinary transaction after
 * load (the editor dispatches one to sync comment highlights, selection restore, ...) adds the paragraph and tiptap emits "update".
 * DocEditor autosaves on every update, so the doc was rewritten (new revision and updatedAt) on every view although the paragraph
 * serializes to nothing and the markdown is identical. The fix: an update whose markdown equals what is already saved is not a save.
 */
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/react"

const actions = vi.hoisted(() => {
  const none = async () => ({})
  return {
    updateDoc: vi.fn(async () => ({ revision: "rev-2" })),
    resolveDocEmbedRefs: vi.fn(async () => ({ cards: {}, deferred: [] })),
    createDocVersion: none, addDocCommentWithTask: none, resolveDocComment: none, deleteDocComment: none, getDocLinkedTasks: none, restoreDocVersion: none,
  }
})
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => actions)
vi.mock("@/auth", () => ({ auth: () => undefined }))
vi.mock("@/lib/db", () => ({ default: () => undefined }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { DocEditor } from "@/components/docs/doc-editor"
import { renderSpecTemplate, type SpecTemplateData } from "@/lib/spec-docs/template"

afterEach(() => {
  cleanup()
  actions.updateDoc.mockClear()
})

const rec = (n: number, title: string) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, title })
const SOLUTION: SpecTemplateData = {
  scopeType: "SOLUTION", solution: rec(1, "Checkout redesign"), keyResults: [rec(2, "Cut drop-off to 20%")],
  assumptions: [rec(4, "Users trust saved cards")], experiments: [rec(6, "Fake-door test")], artifacts: [rec(7, "Prototype v1")],
}
const PLAN: SpecTemplateData = {
  scopeType: "OPPORTUNITY", opportunity: rec(1, "Cart abandonment"), keyResults: [rec(2, "Cut drop-off")], objectives: [rec(3, "Grow revenue")],
  solutions: [rec(4, "Checkout redesign")], assumptions: [rec(6, "Users trust saved cards")], experiments: [rec(7, "Fake-door test")], artifacts: [rec(8, "Prototype v1")],
}
const STANDARD_ENDING_IN_HEADING = "# Notes\n\nSome text.\n\n## Open questions\n"

async function mount(content: string) {
  render(
    <DocEditor
      doc={{ id: "d1", title: "Doc", content, icon: null, revision: "rev-1", metadata: null }}
      versions={[]} comments={[]} revalidatePathStr="/acme/alpha/docs/d1" orgSlug="acme" workspaceSlug="alpha" workspaceId="w1"
      linkedTasks={{ deliveryTasks: [], linkableTasks: [], members: [] }}
    />
  )
  await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull())
  return (document.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 1600))

describe.each([["Spec", renderSpecTemplate(SOLUTION)], ["Discovery Plan", renderSpecTemplate(PLAN)], ["a plain doc ending in a heading", STANDARD_ENDING_IN_HEADING]])("%s opened in DocEditor", (_name, markdown) => {
  it("does not save just by being opened", async () => {
    await mount(markdown)
    await settle()
    expect(actions.updateDoc).not.toHaveBeenCalled()
  })

  it("does not save on load or on an ordinary no-op transaction (the trailing paragraph is not a content change)", async () => {
    const editor = await mount(markdown)
    // A transaction that changes no content but is not silent: the doc is re-applied unchanged, TrailingNode appends its empty
    // paragraph and the editor emits "update" (in the browser the first ordinary transaction after load does this).
    editor.commands.setContent(markdown, { emitUpdate: true })
    await settle()
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph") // TrailingNode did add the empty paragraph
    expect(actions.updateDoc).not.toHaveBeenCalled()
  })

  it("still saves a real edit", async () => {
    const editor = await mount(markdown)
    editor.commands.setContent(markdown, { emitUpdate: true })
    editor.commands.focus("end", { scrollIntoView: false })
    editor.commands.insertContent("Added by a person")
    await settle()
    expect(actions.updateDoc).toHaveBeenCalledTimes(1)
    const [, change] = actions.updateDoc.mock.calls[0] as unknown as [string, { content: string }]
    expect(change.content).toContain("Added by a person")
  })
})
