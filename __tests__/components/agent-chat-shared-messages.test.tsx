// @vitest-environment jsdom
//
// TASK-195 S1: how AgentChat renders person-authored messages in a shared conversation, and which ones it lets you edit.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const PERSON = "11111111-1111-4111-8111-111111111111"
const PR = "https://github.com/rbcodelabs/compass/pull/42"

type Msg = {
  id: string
  role: "user" | "assistant"
  content: string
  authorUserId?: string | null
  authorName?: string | null
  editedAt?: string | null
  canEdit?: boolean
}

const MESSAGES: Msg[] = [
  { id: "m-mine", role: "user", content: `**shipping** it, ping @[Dana](mention:user:${PERSON}) ${PR}`, authorUserId: "user-1", authorName: "Rick", canEdit: true, editedAt: "2026-11-19T10:00:00.000Z" },
  { id: "m-other", role: "user", content: "second *opinion*", authorUserId: "user-2", authorName: "Lee", canEdit: false },
  { id: "m-agent", role: "assistant", content: "Agent reply **here**", canEdit: false },
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

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentChat shared messages", () => {
  it("renders a person's message as markdown with a mention chip and an Edited marker", async () => {
    render(<AgentChat {...props()} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(rows).toHaveLength(3)
    const mine = rows[0]!
    expect(mine).toHaveAttribute("data-message-id", "m-mine")
    expect(mine).toHaveAttribute("id", "message-m-mine")
    expect(within(mine).getByText("shipping").tagName).toBe("STRONG")
    expect(within(mine).getByTestId("comment-mention")).toHaveTextContent("@Dana")
    expect(within(mine).getByTestId("message-edited-marker")).toBeInTheDocument()
    expect(within(rows[1]!).getByText("opinion").tagName).toBe("EM")
  })

  it("offers Edit only on messages the server marked canEdit, never on someone else's or the agent's", async () => {
    render(<AgentChat {...props()} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(within(rows[0]!).getByRole("button", { name: "Edit comment by Rick" })).toBeInTheDocument()
    expect(within(rows[1]!).queryByRole("button", { name: /Edit comment/ })).toBeNull()
    expect(within(rows[2]!).queryByRole("button", { name: /Edit comment/ })).toBeNull()
  })

  it("shows an admin the Edit action on another member's message when the server says so", async () => {
    render(<AgentChat {...props({ initialMessages: [{ ...MESSAGES[1], canEdit: true }] })} />)
    expect(await screen.findByRole("button", { name: "Edit comment by Lee" })).toBeInTheDocument()
  })

  it("updates the message in place after a saved edit, without reordering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "PATCH" && String(url).includes("/messages/m-mine")
          ? Response.json({ message: { id: "m-mine", content: "rewritten", editedAt: "2026-11-19T11:00:00.000Z" } })
          : new Response("{}", { status: 200 }),
      ),
    )
    render(<AgentChat {...props()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit comment by Rick" }))
    fireEvent.click(await screen.findByRole("button", { name: "Save edit" }))
    await waitFor(() => expect(screen.getByText("rewritten")).toBeInTheDocument())
    const rows = screen.getAllByTestId("conversation-message")
    expect(rows.map((r) => r.getAttribute("data-message-id"))).toEqual(["m-mine", "m-other", "m-agent"])
    expect(screen.queryByTestId("message-edit-form")).toBeNull()
  })

  it("keeps a private chat's user messages plain text with no edit action", async () => {
    render(<AgentChat {...props({ initialVisibility: "PRIVATE" })} />)
    const rows = await screen.findAllByTestId("conversation-message")
    expect(within(rows[0]!).queryByTestId("comment-mention")).toBeNull()
    expect(within(rows[0]!).queryByRole("button", { name: /Edit comment/ })).toBeNull()
    expect(rows[0]!.querySelector("strong")).toBeNull()
  })

  it("falls back to a neutral name, never an empty one, in the Edit label", async () => {
    render(<AgentChat {...props({ initialMessages: [{ id: "m-x", role: "user", content: "hi", authorUserId: "user-1", authorName: null, canEdit: true }] })} />)
    expect(await screen.findByRole("button", { name: "Edit comment by Participant" })).toBeInTheDocument()
  })

  it("loads the workspace's mention options up front when something is editable, so the first Edit click has them", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<AgentChat {...props()} />)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/agent/conversations/by-target?workspaceId=ws-1"))).toBe(true),
    )
  })
})
