// @vitest-environment jsdom
//
// TASK-195 S3: AgentChat highlights and scrolls to the message a comment-origin deep link points at.
import { cleanup, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MESSAGES = [
  { id: "m-root", role: "user" as const, content: "first", authorUserId: "user-2", authorName: "Lee" },
  { id: "m-reply", role: "user" as const, content: "second", authorUserId: "user-1", authorName: "Rick" },
]

function props(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    basePath: "/acme/product",
    conversations: [{ id: CONV, title: "Thread" }],
    activeConversationId: CONV,
    initialMessages: MESSAGES,
    userInitials: "RB",
    userId: "user-1",
    initialVisibility: "WORKSPACE" as const,
    ...over,
  }
}

let scroll: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>
/** The transcript already scrolls its own end into view; only calls on a message row are the deep link's. */
const scrolledRows = () => scroll.mock.contexts.filter((el) => el instanceof HTMLElement && el.getAttribute("data-testid") === "conversation-message") as HTMLElement[]
beforeEach(() => {
  scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>()
  Element.prototype.scrollIntoView = scroll
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentChat focusMessageId", () => {
  it("marks only the linked message, gives it a visible ring, and scrolls it into view", async () => {
    render(<AgentChat {...props({ focusMessageId: "m-reply" })} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(rows[1]).toHaveAttribute("data-comment-focused", "true")
    expect(rows[1]!.className).toMatch(/ring-2/)
    expect(rows[0]).not.toHaveAttribute("data-comment-focused")
    expect(scrolledRows()).toEqual([rows[1]])
  })

  it("announces the focus politely, once", async () => {
    render(<AgentChat {...props({ focusMessageId: "m-root" })} />)
    await screen.findAllByTestId("conversation-message")
    const status = screen.getAllByRole("status").find((el) => /linked message/i.test(el.textContent ?? ""))
    expect(status).toBeDefined()
    expect(status).toHaveAttribute("aria-live", "polite")
  })

  it("does nothing, and says nothing, when the linked message is not in this conversation", async () => {
    render(<AgentChat {...props({ focusMessageId: "someone-elses" })} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(rows.some((row) => row.hasAttribute("data-comment-focused"))).toBe(false)
    expect(scrolledRows()).toEqual([])
    expect(screen.queryByText(/linked message/i)).toBeNull()
  })

  it("scrolls once messages arrive after the first render (slow /messages)", async () => {
    const view = render(<AgentChat {...props({ initialMessages: [], focusMessageId: "m-reply" })} />)
    expect(scrolledRows()).toEqual([])
    view.rerender(<AgentChat {...props({ focusMessageId: "m-reply" })} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(within(rows[1]!).getByText("second")).toBeInTheDocument()
    expect(rows[1]).toHaveAttribute("data-comment-focused", "true")
    expect(scrolledRows()).toEqual([rows[1]])
  })

  it("does not re-scroll on later renders (polling) for the same link", async () => {
    const view = render(<AgentChat {...props({ focusMessageId: "m-reply" })} />)
    await screen.findAllByTestId("conversation-message")
    view.rerender(<AgentChat {...props({ focusMessageId: "m-reply", initialMessages: [...MESSAGES] })} />)
    expect(scrolledRows()).toHaveLength(1)
  })

  it("has no focused message without a link", async () => {
    render(<AgentChat {...props()} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(rows.some((row) => row.hasAttribute("data-comment-focused"))).toBe(false)
    expect(scrolledRows()).toEqual([])
  })
})
