// @vitest-environment jsdom
/**
 * Regression: opening a SPEC doc must not save it. The template's markdown has to be a fixed point of the doc editor's parse then
 * serialize, and mounting the editor (with its card node views) must not emit an update, because DocEditor autosaves on every update.
 */
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor, EditorContent } from "@tiptap/react"
import type { MarkdownStorage } from "tiptap-markdown"
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions"
import { DocEmbedCardsProvider } from "@/components/docs/doc-embed-cards"
import { renderSpecTemplate, type SpecTemplateData, type SpecTemplateVariant } from "@/lib/spec-docs/template"

afterEach(cleanup)

const rec = (n: number, title: string) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, title })
const markdownOf = (editor: Editor) => (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()

const SOLUTION: SpecTemplateData = {
  scopeType: "SOLUTION",
  solution: rec(1, "Checkout redesign"),
  keyResults: [rec(2, "Cut drop-off to 20%"), rec(3, "Raise [conversion] by 5\\%")],
  assumptions: [rec(4, "Users trust saved cards"), rec(5, "Guest checkout is enough")],
  experiments: [rec(6, "Fake-door test")],
  artifacts: [rec(7, "Prototype v1")],
}
const PLAN: SpecTemplateData = {
  scopeType: "OPPORTUNITY",
  opportunity: rec(1, "Cart abandonment"),
  keyResults: [rec(2, "Cut drop-off")],
  objectives: [rec(3, "Grow revenue")],
  solutions: [rec(4, "Checkout redesign"), rec(5, "Saved carts")],
  assumptions: [rec(6, "Users trust saved cards")],
  experiments: [rec(7, "Fake-door test")],
  artifacts: [rec(8, "Prototype v1")],
}
const EMPTY_SOLUTION: SpecTemplateData = { ...SOLUTION, keyResults: [], assumptions: [], experiments: [], artifacts: [] } as SpecTemplateData

const CASES: [string, SpecTemplateData, SpecTemplateVariant][] = [
  ["Spec", SOLUTION, "default"],
  ["Spec (empty sections)", EMPTY_SOLUTION, "default"],
  ["Spec (blank)", SOLUTION, "blank"],
  ["Discovery Plan", PLAN, "default"],
  ["Discovery Plan (blank)", PLAN, "blank"],
]

describe.each(CASES)("%s template", (_name, data, variant) => {
  const markdown = renderSpecTemplate(data, variant)

  it("is a fixed point of the doc editor's parse then serialize (apart from the trailing newline)", () => {
    const editor = new Editor({ extensions: createDocEditorExtensions([]), content: markdown })
    expect(markdownOf(editor)).toBe(markdown.replace(/\n+$/, ""))
    editor.destroy()
  })

  it("mounting the editor with its card node views emits no update, so nothing is autosaved", async () => {
    const onUpdate = vi.fn()
    const resolve = vi.fn(async () => ({ cards: {}, deferred: [] }))
    const editor = new Editor({ extensions: createDocEditorExtensions([]), content: markdown, onUpdate })
    render(
      <DocEmbedCardsProvider resolve={resolve}>
        <EditorContent editor={editor} />
      </DocEmbedCardsProvider>
    )
    await waitFor(() => expect(document.querySelector("[data-compass-embed]") !== null || variant === "blank").toBe(true))
    await new Promise((r) => setTimeout(r, 100))
    editor.setEditable(true, false)
    expect(onUpdate).not.toHaveBeenCalled()
    editor.destroy()
  })
})
