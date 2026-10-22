// @vitest-environment jsdom
/** The "/" menu stays inside the visible viewport wherever the caret is (it used to hang off the bottom when typing on the last line). */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/react"

const actions = vi.hoisted(() => ({
  updateDoc: vi.fn(async () => ({ revision: "rev-2" })),
  resolveDocEmbedRefs: vi.fn(async () => ({ cards: {}, deferred: [], canEdit: true })),
  createDocVersion: async () => ({}), addDocCommentWithTask: async () => ({}), resolveDocComment: async () => ({}), deleteDocComment: async () => ({}), getDocLinkedTasks: async () => ({}), restoreDocVersion: async () => ({}),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => actions)
vi.mock("@/auth", () => ({ auth: () => undefined }))
vi.mock("@/lib/db", () => ({ default: () => undefined }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { DocEditor } from "@/components/docs/doc-editor"

const MENU_H = 120
const realVV = Object.getOwnPropertyDescriptor(window, "visualViewport")
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")
afterEach(() => {
  cleanup()
  if (realVV) Object.defineProperty(window, "visualViewport", realVV)
  else Reflect.deleteProperty(window, "visualViewport")
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight)
})

async function open(caret: { top: number; bottom: number; left: number }, viewport: { width: number; height: number; offsetTop?: number }) {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: { width: viewport.width, height: viewport.height, offsetLeft: 0, offsetTop: viewport.offsetTop ?? 0, addEventListener() {}, removeEventListener() {} } })
  render(
    <DocEditor
      doc={{ id: "d1", title: "Doc", content: "# Spec\n\nIntro.\n", icon: null, revision: "rev-1", metadata: null }}
      versions={[]} comments={[]} revalidatePathStr="/acme/alpha/docs/d1" orgSlug="acme" workspaceSlug="alpha" workspaceId="w1"
      linkedTasks={{ deliveryTasks: [], linkableTasks: [], members: [] }}
      specScopes={[{ scopeType: "SOLUTION", scopeId: "s1", title: "Checkout" }]}
    />
  )
  await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull())
  const editor = (document.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => MENU_H })
  editor.view.coordsAtPos = (() => ({ ...caret, right: caret.left + 1 })) as never
  act(() => {
    editor.chain().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "/" }] }).run()
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  const el = await screen.findByTestId("spec-slash-menu")
  const top = parseFloat(el.style.top), left = parseFloat(el.style.left), width = parseFloat(el.style.width), maxHeight = parseFloat(el.style.maxHeight)
  const height = Math.min(MENU_H, maxHeight)
  const oy = viewport.offsetTop ?? 0
  // Every edge inside the visible viewport.
  expect(top).toBeGreaterThanOrEqual(oy)
  expect(left).toBeGreaterThanOrEqual(0)
  expect(left + width).toBeLessThanOrEqual(viewport.width)
  expect(top + height).toBeLessThanOrEqual(oy + viewport.height)
  return { top, height, maxHeight }
}

describe('"/" menu placement', () => {
  it("a caret near the bottom flips the menu above the caret line", async () => {
    const box = await open({ top: 680, bottom: 700, left: 100 }, { width: 1280, height: 720 })
    expect(box.top + box.height).toBeLessThanOrEqual(680)
  })
  it("the menu has a solid popover surface, never the translucent overlay token or an alpha background", async () => {
    await open({ top: 100, bottom: 120, left: 100 }, { width: 1280, height: 720 })
    const cls = screen.getByTestId("spec-slash-menu").className
    expect(cls).toContain("bg-popover")
    expect(cls).not.toContain("surface-overlay")
    expect(cls).not.toMatch(/\bbg-[\w-]+\/\d+/)
  })
  it("a caret near the top keeps the menu below it", async () => {
    const box = await open({ top: 100, bottom: 120, left: 100 }, { width: 1280, height: 720 })
    expect(box.top).toBeGreaterThanOrEqual(120)
  })
  it("a tiny viewport pins the menu inside it and caps its height so it scrolls", async () => {
    const box = await open({ top: 100, bottom: 120, left: 100 }, { width: 390, height: 100 })
    expect(box.maxHeight).toBeLessThanOrEqual(100 - 16)
  })
  it("an on-screen keyboard (short, offset visual viewport) is respected", async () => {
    await open({ top: 330, bottom: 350, left: 100 }, { width: 390, height: 320, offsetTop: 40 })
  })
})
