// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom/vitest"

import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions"
import { setCommentHighlights, type CommentAnchorData } from "@/components/docs/comment-highlight-extension"
import { editorMarkdown } from "@/components/markdown-editor-extensions"
import { MarkdownDescriptionEditor } from "@/components/markdown-description-editor"
import { MarkdownContent } from "@/components/markdown-content"
import { MentionAwareLink } from "@/components/comments/mention-chips"
import { WorkItemLinkScopeProvider } from "@/components/work-item-link-scope"
import { clearPullRequestCache } from "@/components/github/use-pull-request"
import type { PullRequestSummary } from "@/lib/github-pull-request-summary"

const openPanel = vi.fn()
vi.mock("@/components/panels/panel-context", () => ({
  useOptionalPanelContext: () => ({ openPanel }),
}))

const PR_URL = "https://github.com/rbcodelabs/compass/pull/209"
const PR_SUMMARY: PullRequestSummary = {
  owner: "rbcodelabs",
  repo: "compass",
  number: 209,
  url: PR_URL,
  title: "[WIP] Support smart PR chips",
  state: "open",
  author: "rickbowman",
  baseRef: "main",
  headRef: "feat/github-pr-smart-chips",
  body: "Adds smart chips across Docs and Markdown.",
  additions: 120,
  deletions: 14,
  changedFiles: 5,
  commits: 2,
  comments: 1,
  reviewComments: 0,
  mergeable: true,
  checks: "passing",
  failingChecks: [],
  updatedAt: "2026-11-16T22:00:00Z",
}

function DocHarness({
  initialContent = "",
  comments = [],
  onReady,
}: {
  initialContent?: string
  comments?: CommentAnchorData[]
  onReady?: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: createDocEditorExtensions(comments),
    content: initialContent,
    immediatelyRender: true,
  })
  if (editor && onReady) onReady(editor)
  return <EditorContent editor={editor} />
}

function DescriptionHarness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <div>
      <MarkdownDescriptionEditor label="Task description" value={value} onChange={setValue} />
      <output data-testid="serialized-md">{value}</output>
    </div>
  )
}

afterEach(() => {
  openPanel.mockClear()
  clearPullRequestCache()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("GitHub PR smart chips in TipTap Docs & rich editors", () => {
  it("rewrites a newly inserted bare PR URL to #<number> <Title>, keeps MarkViewContent mounted, supports undo, and round-trips Markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PR_SUMMARY }),
    )
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)

    let editor!: Editor
    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <DocHarness initialContent="" onReady={(e) => { editor = e }} />
      </WorkItemLinkScopeProvider>,
    )

    editor.commands.focus("end")
    editor.commands.insertContent("Review ")
    editor.commands.insertContent({
      type: "text",
      text: PR_URL,
      marks: [{ type: "link", attrs: { href: PR_URL } }],
    })

    // MarkViewContent stays mounted from insertion through async resolution.
    expect(container.querySelector("[data-mark-view-content]")).not.toBeNull()

    const chip = await waitFor(() => {
      const el = container.querySelector<HTMLAnchorElement>('a[data-github-pr-link="ready"]')
      expect(el).not.toBeNull()
      expect(el?.textContent).toContain("#209 [WIP] Support smart PR chips")
      return el!
    })

    expect(chip.querySelector("[data-mark-view-content]")).not.toBeNull()
    expect(screen.getByRole("img", { name: "Open" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Checks passing" })).toBeInTheDocument()

    // Cursor lands AFTER the rewritten smart chip with stored link mark cleared so typing/Enter appends after the chip, not before/inside it.
    editor.commands.insertContent(" today")
    expect(editor.state.doc.textContent).toBe("Review #209 [WIP] Support smart PR chips today")
    const serialized = editorMarkdown(editor)
    expect(serialized).toContain(`](${PR_URL}) today`)
    expect(serialized).toContain("#209")
    const baselineJson = editor.getJSON()
    for (let i = 0; i < 5; i++) {
      editor.commands.setContent(editorMarkdown(editor))
      expect(editor.getJSON()).toEqual(baselineJson)
    }

    // Plain click opens the pullRequest detail sidebar in place; Cmd/Ctrl-click opens GitHub in a new tab.
    fireEvent.click(chip)
    expect(openPanel).toHaveBeenCalledWith("pullRequest", "rbcodelabs/compass/209")
    fireEvent.click(chip, { metaKey: true })
    expect(openSpy).toHaveBeenCalledWith(PR_URL, "_blank", "noopener,noreferrer")
    expect(openPanel).toHaveBeenCalledTimes(1)

    // Rebuild history cleanly on a fresh paste to verify single-step undo keeps the raw URL without re-rewriting.
    editor.commands.setContent("")
    editor.commands.insertContent({
      type: "text",
      text: PR_URL,
      marks: [{ type: "link", attrs: { href: PR_URL } }],
    })
    await waitFor(() => expect(editor.state.doc.textContent).toBe("#209 [WIP] Support smart PR chips"))

    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe(PR_URL)
    // Confirm undo does not trigger an automatic re-rewrite back to the title.
    await new Promise((r) => setTimeout(r, 30))
    expect(editor.state.doc.textContent).toBe(PR_URL)
  })

  it("preserves custom [label](url) text untouched and keeps inline comment highlights intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PR_SUMMARY }),
    )

    const source = `Shipped via [our custom PR label](${PR_URL}) today.`
    let editor!: Editor
    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <DocHarness initialContent={source} onReady={(e) => { editor = e }} />
      </WorkItemLinkScopeProvider>,
    )

    const chip = await waitFor(() => {
      const el = container.querySelector<HTMLAnchorElement>('a[data-github-pr-link="ready"]')
      expect(el).not.toBeNull()
      return el!
    })

    expect(chip.textContent).toBe("our custom PR label")
    expect(editorMarkdown(editor)).toBe(source)

    // Anchor an inline comment across the custom PR label inside MarkViewContent.
    const fullText = "Shipped via our custom PR label today."
    const anchorText = "our custom PR label"
    const anchorStart = fullText.indexOf(anchorText)
    setCommentHighlights(
      editor,
      [
        {
          id: "c-1",
          anchorText,
          anchorStart,
          anchorEnd: anchorStart + anchorText.length,
          anchorPrefix: fullText.slice(0, anchorStart),
          anchorSuffix: fullText.slice(anchorStart + anchorText.length),
        },
      ],
      "c-1",
    )

    await waitFor(() => {
      const highlight = container.querySelector(".doc-comment-highlight")
      expect(highlight).not.toBeNull()
      expect(highlight?.textContent).toBe("our custom PR label")
    })
  })

  it("falls back to a plain <a> without mutating text when unapproved/404, 503, or outside workspace scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "Not found" }) })
    vi.stubGlobal("fetch", fetchMock)

    let editor!: Editor
    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <DocHarness initialContent="" onReady={(e) => { editor = e }} />
      </WorkItemLinkScopeProvider>,
    )

    editor.commands.insertContent({
      type: "text",
      text: PR_URL,
      marks: [{ type: "link", attrs: { href: PR_URL } }],
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector("a[data-github-pr-link]")).toBeNull())

    const plainAnchor = container.querySelector(`a[href="${PR_URL}"]`)
    expect(plainAnchor).not.toBeNull()
    expect(plainAnchor?.querySelector("[data-mark-view-content]")).not.toBeNull()
    expect(editor.state.doc.textContent).toBe(PR_URL)
  })

  it("supports PR smart chips inside MarkdownDescriptionEditor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PR_SUMMARY }),
    )

    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <DescriptionHarness initialValue={`Tracked in [PR 209](${PR_URL}).`} />
      </WorkItemLinkScopeProvider>,
    )

    const chip = await waitFor(() => {
      const el = container.querySelector<HTMLAnchorElement>('a[data-github-pr-link="ready"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(chip.textContent).toBe("PR 209")
  })
})

describe("GitHub PR smart chips in rendered Markdown (MarkdownContent & MentionAwareLink)", () => {
  it("rewrites bare PR URLs to #<number> <Title>, preserves custom labels, and opens the PR sidebar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PR_SUMMARY }),
    )

    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <MarkdownContent>{`Bare: ${PR_URL} and custom: [the fix](${PR_URL})`}</MarkdownContent>
      </WorkItemLinkScopeProvider>,
    )

    await waitFor(() => {
      const chips = container.querySelectorAll('a[data-entity-card="pullRequest"]')
      expect(chips).toHaveLength(2)
      expect(chips[0]?.textContent).toContain("#209 [WIP] Support smart PR chips")
      expect(chips[1]?.textContent).toContain("the fix")
    })

    const firstChip = container.querySelector('a[data-entity-card="pullRequest"]')!
    expect(fireEvent.click(firstChip)).toBe(false)
    expect(openPanel).toHaveBeenCalledWith("pullRequest", "rbcodelabs/compass/209")
    expect(fireEvent.click(firstChip, { ctrlKey: true })).toBe(true)
    expect(openPanel).toHaveBeenCalledTimes(1)
  })

  it("renders PR smart chips alongside @mentions in MentionAwareLink (discussion comments)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PR_SUMMARY }),
    )

    const { container } = render(
      <WorkItemLinkScopeProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <MarkdownContent linkComponent={MentionAwareLink}>
          {`[@Rick](mention:user:11111111-1111-4111-8111-111111111111) landed ${PR_URL}`}
        </MarkdownContent>
      </WorkItemLinkScopeProvider>,
    )

    expect(screen.getByTestId("comment-mention")).toHaveTextContent("@Rick")
    await waitFor(() => {
      const chip = container.querySelector('a[data-entity-card="pullRequest"]')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toContain("#209 [WIP] Support smart PR chips")
    })
  })

  it("falls back to plain <a> without fetching when rendered outside WorkItemLinkScope (e.g. public Portal Docs)", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const { container } = render(<MarkdownContent>{`Public doc link: ${PR_URL}`}</MarkdownContent>)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-entity-card="pullRequest"]')).toBeNull()
    const link = screen.getByRole("link", { name: PR_URL })
    expect(link).toHaveAttribute("href", PR_URL)
    expect(link).toHaveAttribute("target", "_blank")
  })
})
