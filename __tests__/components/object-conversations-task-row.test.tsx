// @vitest-environment jsdom
//
// TASK-195 S4: the Conversations section composer's task row. A task-bearing root post is a comment (POST /api/comments),
// never a chat turn; a plain post still goes through /api/agent/turn.
import React, { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { serializeMention } from "@/lib/comment-mentions"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn() }))
vi.mock("@/components/panels/conversation-panel", () => ({ useConversationPanelOptional: () => ({ workspaceId: "workspace", orgSlug: "acme", workspaceSlug: "core", openConversationInPanel: mocks.open, startNewConversationInPanel: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
vi.mock("@/components/docs/mention-editor", () => ({
  MentionEditor: ({ initialValue = "", onChange, onSubmitShortcut, disabled, ariaLabel, testId }: { initialValue?: string; onChange: (value: string) => void; onSubmitShortcut: () => void; disabled: boolean; ariaLabel: string; testId?: string }) => {
    const [value, setValue] = useState(initialValue)
    return <textarea aria-label={ariaLabel} data-testid={testId} value={value} disabled={disabled} onChange={e => { setValue(e.target.value); onChange(e.target.value) }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onSubmitShortcut() } }} />
  },
}))
import { ObjectConversationsSection } from "@/components/conversations/object-conversations-section"

const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"
const quinn = serializeMention({ kind: "user", id: QUINN, label: "Quinn Morales" })
const bot = serializeMention({ kind: "agent", id: BOT, label: "QA Agent" })
const mentionOptions = {
  people: [{ kind: "user", id: QUINN, name: "Quinn Morales", detail: "quinn@example.com" }],
  agents: [{ kind: "agent", id: BOT, name: "QA Agent", detail: "Agent", access: "WRITE", agentKind: "CLOUD" }],
  outside: [],
}
const item = { id: "conversation", title: "Team thread", summary: null, status: "OPEN", visibility: "WORKSPACE", agentMode: "MENTION_ONLY", messageCount: 1, updatedAt: "2026-11-19T00:00:00Z", anchored: true, links: [] }
const card = { taskId: "task-9", displayId: "TASK-9", title: "Draft the rollout", status: "TODO", priority: "HIGH", dueDate: null, assignee: { type: "USER", id: QUINN, displayName: "Quinn Morales", available: true } }
let list: Record<string, unknown>
const mount = () => render(<ObjectConversationsSection targetType="roadmap_item" targetId="item-1" targetLabel="Q4 launch" />)
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
const postedTo = (path: string) => posts().filter(([url]) => String(url) === path)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("fetch", mocks.fetch)
  list = { items: [item], mentionOptions, confirmedAgentIds: [], targetTitle: "Q4 launch" }
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url === "/api/comments") return Response.json({ id: "comment-1", taskCard: card }, { status: 201 })
    if (init?.method === "POST") return Response.json({ conversationId: "turn-conversation" })
    return Response.json(list)
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function composeWith(body: string) {
  await screen.findByRole("button", { name: /Team thread/ })
  fireEvent.change(screen.getByRole("textbox", { name: "Start a conversation" }), { target: { value: body } })
}

describe("task row in the section composer", () => {
  it("offers the task box once someone is mentioned, with the shipped selectors", async () => {
    mount()
    await composeWith(`Can you draft this ${quinn}`)
    expect(screen.getByTestId("comment-task-box")).toHaveTextContent("Assign as task to @Quinn Morales")
    expect(screen.getByRole("switch", { name: "Create task" })).toBeChecked()
    expect(screen.getByRole("button", { name: "Comment & create task" })).toBeEnabled()
    expect(screen.getByTestId("object-conversation-composer")).toBeInTheDocument()
  })

  it("posts a task-bearing root through /api/comments, starts no chat turn, and opens the new conversation", async () => {
    mount()
    await composeWith(`Can you draft this ${quinn}`)
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("comment-1", expect.objectContaining({ targetType: "ROADMAP_ITEM", targetId: "item-1", visibility: "WORKSPACE" })))
    expect(postedTo("/api/agent/turn")).toHaveLength(0)
    const [[, init]] = postedTo("/api/comments")
    expect(JSON.parse(init.body)).toEqual({
      targetType: "ROADMAP_ITEM", targetId: "item-1", parentId: null, body: `Can you draft this ${quinn}`,
      task: { title: expect.any(String), dueDate: null, priority: "MEDIUM" },
      assignee: { kind: "user", id: QUINN },
      agentScopeConfirmed: false,
    })
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a conversation" })).toHaveValue(""))
  })

  it("keeps the draft and says why when the task cannot be created", async () => {
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ error: "x", code: "ASSIGNEE_NOT_IN_WORKSPACE" }, { status: 422 }) : Response.json(list))
    mount()
    await composeWith(`Please ${quinn}`)
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    expect(await screen.findByTestId("composer-error")).toHaveTextContent("That person is not in this workspace")
    expect(screen.getByRole("textbox", { name: "Start a conversation" })).toHaveValue(`Please ${quinn}`)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(postedTo("/api/agent/turn")).toHaveLength(0)
  })

  it("keeps the old quick-start (a chat turn, no comment) when the task is switched off", async () => {
    mount()
    await composeWith(`FYI ${quinn}`)
    fireEvent.click(screen.getByRole("switch", { name: "Create task" }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("turn-conversation", expect.anything()))
    expect(postedTo("/api/comments")).toHaveLength(0)
    expect(postedTo("/api/agent/turn")).toHaveLength(1)
  })

  it("asks to confirm scope before assigning a task to an agent that holds none here, then posts confirmed", async () => {
    mount()
    await composeWith(`Run this ${bot}`)
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    expect(await screen.findByTestId("agent-scope-confirm")).toBeInTheDocument()
    expect(posts()).toHaveLength(0)
    fireEvent.click(screen.getByTestId("confirm-agent-assign"))
    await waitFor(() => expect(postedTo("/api/comments")).toHaveLength(1))
    expect(JSON.parse(postedTo("/api/comments")[0][1].body)).toMatchObject({ assignee: { kind: "agent", id: BOT }, agentScopeConfirmed: true })
    expect(postedTo("/api/agent/turn")).toHaveLength(0)
  })

  it("skips the scope step for an agent the server says already holds a task on this item", async () => {
    list = { ...list, confirmedAgentIds: [BOT] }
    mount()
    await composeWith(`Run this ${bot}`)
    fireEvent.click(screen.getByRole("button", { name: "Comment & create task" }))
    await waitFor(() => expect(postedTo("/api/comments")).toHaveLength(1))
    expect(screen.queryByTestId("agent-scope-confirm")).toBeNull()
  })

  it("still inserts the Compass Agent mention from the Agent button", async () => {
    mount()
    await screen.findByRole("button", { name: /Team thread/ })
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    expect((screen.getByRole("textbox", { name: "Start a conversation" }) as HTMLTextAreaElement).value).toContain("mention:agent:")
  })
})

describe("task card on the conversation row", () => {
  it("shows the root's task as a chip and a card that opens the task", async () => {
    list = { ...list, items: [{ ...item, taskCard: card }] }
    mount()
    const row = (await screen.findByRole("button", { name: /Team thread/ })).closest("li")!
    expect(within(row).getByTestId("comment-task-card")).toHaveTextContent("Draft the rollout")
    expect(within(row).getByTestId("open-task-link")).toHaveAttribute("href", "/acme/core/tasks/task-9")
    expect(within(row).getByTestId("conversation-task-chip")).toHaveTextContent("TASK-9")
  })

  it("shows no task UI on a row without one", async () => {
    mount()
    const row = (await screen.findByRole("button", { name: /Team thread/ })).closest("li")!
    expect(within(row).queryByTestId("comment-task-card")).toBeNull()
    expect(within(row).queryByTestId("conversation-task-chip")).toBeNull()
  })
})
