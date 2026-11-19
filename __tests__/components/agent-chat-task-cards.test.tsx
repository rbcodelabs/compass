// @vitest-environment jsdom
//
// TASK-195 S4: the task card under the message a task was made from, in the conversation panel.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
import { AgentChat } from "@/components/agent/agent-chat"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const card = { taskId: "task-9", displayId: "TASK-9", title: "Draft the rollout", status: "TODO", priority: "HIGH", dueDate: null, assignee: { type: "USER", id: "u", displayName: "Quinn Morales", available: true } }
const MESSAGES = [
  { id: "m-task", role: "user" as const, content: "please do this", authorUserId: "user-2", authorName: "Lee", createdAt: "2026-11-19T10:00:00.000Z" },
  { id: "m-plain", role: "user" as const, content: "thanks", authorUserId: "user-2", authorName: "Lee", createdAt: "2026-11-19T10:01:00.000Z" },
]
const props = (over: Record<string, unknown> = {}) => ({
  workspaceId: "ws-1", basePath: "/acme/product", conversations: [{ id: CONV, title: "Thread" }], activeConversationId: CONV,
  initialMessages: MESSAGES, userInitials: "RB", userId: "user-1", initialVisibility: "WORKSPACE" as const, ...over,
})

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("AgentChat task cards", () => {
  it("renders the card under the message it was created from, linking to the task", async () => {
    render(<AgentChat {...props({ initialTaskCards: { "m-task": card } })} />)
    const rows = await screen.findAllByTestId("conversation-message")
    const card0 = within(rows[0]!).getByTestId("comment-task-card")
    expect(card0).toHaveTextContent("Draft the rollout")
    expect(within(rows[0]!).getByTestId("open-task-link")).toHaveAttribute("href", "/acme/product/tasks/task-9")
    expect(within(rows[1]!).queryByTestId("comment-task-card")).toBeNull()
  })

  it("shows no card when the conversation has none", async () => {
    render(<AgentChat {...props()} />)
    await screen.findAllByTestId("conversation-message")
    expect(screen.queryByTestId("comment-task-card")).toBeNull()
  })

  it("picks up a card for a new message that arrives by polling", async () => {
    const incoming = { id: "m-new", role: "user", content: "new ask", authorUserId: "user-2", authorName: "Lee", createdAt: "2026-11-19T10:05:00.000Z" }
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/messages") ? Response.json({ messages: [incoming], taskCards: { "m-new": card } }) : new Response("{}", { status: 200 })))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<AgentChat {...props()} />)
      await vi.advanceTimersByTimeAsync(20_000)
      await waitFor(() => expect(screen.getByTestId("comment-task-card")).toBeInTheDocument())
      const row = document.getElementById("message-m-new")!
      expect(within(row).getByTestId("comment-task-card")).toHaveTextContent("Draft the rollout")
    } finally { vi.useRealTimers() }
  })
})
