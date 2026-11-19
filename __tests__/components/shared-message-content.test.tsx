// @vitest-environment jsdom
//
// TASK-195 S1: the shared-message renderer and the in-place editor (components/conversations/message-actions.tsx).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The chip itself is covered elsewhere; here we only need to know a PR link is routed to it.
vi.mock("@/components/github/pull-request-chip", () => ({
  PullRequestChip: ({ href, pr }: { href: string; pr: { number: number } }) => (
    <a data-testid="pull-request-chip" href={href}>PR #{pr.number}</a>
  ),
}))

import { SharedMessageBody, SharedMessageContent } from "@/components/conversations/message-actions"
import type { MentionOptions } from "@/components/docs/mention-editor"

const USER_ID = "11111111-1111-4111-8111-111111111111"
const OPTIONS: MentionOptions = {
  people: [{ kind: "user", id: USER_ID, name: "Dana Reyes", detail: "dana@example.com" }],
  agents: [],
  outside: [],
}
const PR = "https://github.com/rbcodelabs/compass/pull/42"

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SharedMessageBody", () => {
  it("renders markdown, a mention chip with the live name, a PR chip and a normal link", () => {
    const content = `**bold** and ~~gone~~ \`code\` @[Old Name](mention:user:${USER_ID}) see ${PR} and [docs](https://example.com/x)`
    const { container } = render(<SharedMessageBody content={content} mentionOptions={OPTIONS} />)
    expect(container.querySelector("strong")).toHaveTextContent("bold")
    expect(container.querySelector("del")).toHaveTextContent("gone")
    expect(container.querySelector("code")).toHaveTextContent("code")
    const chip = screen.getByTestId("comment-mention")
    expect(chip).toHaveTextContent("@Dana Reyes")
    expect(chip).toHaveAttribute("data-mention-id", USER_ID)
    expect(screen.getByTestId("pull-request-chip")).toHaveAttribute("href", PR)
    const docs = screen.getByRole("link", { name: "docs" })
    expect(docs).toHaveAttribute("href", "https://example.com/x")
    expect(docs).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("falls back to the stored label for a person who is not in the options", () => {
    render(<SharedMessageBody content={`hi @[Gone Person](mention:user:22222222-2222-4222-8222-222222222222)`} mentionOptions={OPTIONS} />)
    expect(screen.getByTestId("comment-mention")).toHaveTextContent("@Gone Person")
  })

  it("never turns raw HTML in a message into DOM", () => {
    const evil = `<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"><a href="javascript:alert(1)">click</a> [bad](javascript:alert(2))`
    const { container } = render(<SharedMessageBody content={evil} mentionOptions={OPTIONS} />)
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    for (const a of Array.from(container.querySelectorAll("a"))) expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i)
    expect(container).toHaveTextContent("<script>")
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})

function renderContent(over: Partial<React.ComponentProps<typeof SharedMessageContent>> = {}, message = {}) {
  const onEdited = vi.fn()
  const view = render(
    <div onKeyDown={(e) => e.key === "Escape" && outerEscape()}>
      <SharedMessageContent
        message={{ id: "m-1", content: "first words", editedAt: null, canEdit: true, ...message }}
        authorLabel="Dana"
        workspaceId="ws-1"
        conversationId="c-1"
        mentionOptions={OPTIONS}
        onEdited={onEdited}
        {...over}
      />
    </div>,
  )
  return { onEdited, ...view }
}
const outerEscape = vi.fn()

describe("SharedMessageContent", () => {
  beforeEach(() => outerEscape.mockClear())

  it("offers Edit only when the server said canEdit", () => {
    renderContent({}, { canEdit: false })
    expect(screen.queryByRole("button", { name: "Edit comment by Dana" })).toBeNull()
    cleanup()
    renderContent()
    expect(screen.getByRole("button", { name: "Edit comment by Dana" })).toBeInTheDocument()
  })

  it("shows the Edited marker only for an edited message", () => {
    renderContent({}, { canEdit: false })
    expect(screen.queryByTestId("message-edited-marker")).toBeNull()
    cleanup()
    renderContent({}, { canEdit: false, editedAt: "2026-11-19T10:00:00.000Z" })
    expect(screen.getByTestId("message-edited-marker")).toHaveTextContent("Edited")
  })

  it("edits in place: Save PATCHes the trimmed text to the message route and reports it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: { id: "m-1", content: "better words", editedAt: "2026-11-19T10:00:00.000Z" } }))
    vi.stubGlobal("fetch", fetchMock)
    const { onEdited } = renderContent()
    fireEvent.click(screen.getByRole("button", { name: "Edit comment by Dana" }))
    const editor = await screen.findByRole("textbox", { name: "Edit comment by Dana" })
    editor.textContent = "  better words "
    fireEvent.input(editor)
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }))
    await waitFor(() => expect(onEdited).toHaveBeenCalledWith({ id: "m-1", content: "better words", editedAt: "2026-11-19T10:00:00.000Z" }))
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("/messages/m-1"))! as unknown as [string, RequestInit]
    expect(url).toBe("/api/agent/conversations/c-1/messages/m-1?workspaceId=ws-1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toEqual({ content: "better words" })
    expect(screen.queryByTestId("message-edit-form")).toBeNull()
  })

  it("Cancel and Escape close only the editor, leaving the text and the surrounding panel alone", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { onEdited } = renderContent()
    fireEvent.click(screen.getByRole("button", { name: "Edit comment by Dana" }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("message-edit-form")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Edit comment by Dana" }))
    const editor = await screen.findByRole("textbox", { name: "Edit comment by Dana" })
    fireEvent.keyDown(editor, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("message-edit-form")).toBeNull())
    expect(outerEscape).not.toHaveBeenCalled()
    expect(onEdited).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText("first words")).toBeInTheDocument()
  })

  it("keeps the editor open and shows a plain error when the save is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("You can't edit this message.", { status: 403 })))
    const { onEdited } = renderContent()
    fireEvent.click(screen.getByRole("button", { name: "Edit comment by Dana" }))
    fireEvent.click(await screen.findByRole("button", { name: "Save edit" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't edit this message.")
    expect(screen.getByTestId("message-edit-form")).toBeInTheDocument()
    expect(onEdited).not.toHaveBeenCalled()
  })
})
