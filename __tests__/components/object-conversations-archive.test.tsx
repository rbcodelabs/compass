// @vitest-environment jsdom
//
// TASK-195 S2: the Conversations section after an archive, the Show archived toggle, and Restore.
import React from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/components/panels/conversation-panel", () => ({ useConversationPanelOptional: () => ({ workspaceId: "workspace", orgSlug: "acme", workspaceSlug: "core", openConversationInPanel: vi.fn(), startNewConversationInPanel: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
vi.mock("@/components/docs/mention-editor", () => ({ MentionEditor: ({ ariaLabel }: { ariaLabel: string }) => <textarea aria-label={ariaLabel} /> }))
import { ObjectConversationsSection } from "@/components/conversations/object-conversations-section"
import { CONVERSATION_ARCHIVE_CHANGED_EVENT } from "@/components/conversations/archive-events"

const base = { summary: null, status: "OPEN", visibility: "WORKSPACE", agentMode: "MENTION_ONLY", messageCount: 2, updatedAt: "2026-11-18T00:00:00Z", anchored: true, links: [] }
const live = { ...base, id: "live", title: "Live thread" }
const gone = { ...base, id: "gone", title: "Archived thread", archived: true, canRestore: true, canArchive: true }

let archivedNow: boolean
let cappedNow = false
beforeEach(() => {
  vi.resetAllMocks()
  archivedNow = false
  cappedNow = false
  vi.stubGlobal("fetch", mocks.fetch)
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return Response.json({ archived: false, changed: true })
    const archived = String(url).includes("archived=1")
    return Response.json({ items: archived ? [gone] : archivedNow ? [] : [live], ...(archived && cappedNow ? { archivedCapped: true } : {}) })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const listCalls = () => mocks.fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("by-target"))

describe("Show archived", () => {
  it("does not ask for archived rows until toggled", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    expect(listCalls().every((url) => !url.includes("archived=1"))).toBe(true)
    expect(screen.getByRole("button", { name: "Show archived" })).toHaveAttribute("aria-pressed", "false")
  })

  it("lists archived rows with a Restore action and no Archive or delete", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    const row = (await screen.findByText("Archived thread")).closest("li")!
    expect(screen.getByRole("button", { name: "Show archived" })).toHaveAttribute("aria-pressed", "true")
    expect(within(row).getByRole("button", { name: "Restore" })).toBeInTheDocument()
    expect(within(row).queryByRole("button", { name: /delete/i })).toBeNull()
    expect(screen.queryByText("Live thread")).toBeNull()
  })

  it("restores, drops the row from the archived list, says so, and returns focus to the heading", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    const row = (await screen.findByText("Archived thread")).closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Restore" }))
    await waitFor(() => expect(screen.queryByText("Archived thread")).toBeNull())
    const patch = mocks.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!
    expect(String(patch[0])).toBe("/api/agent/conversations/gone?workspaceId=workspace")
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ archived: false })
    expect(screen.getByRole("status")).toHaveTextContent("Conversation restored.")
    expect(screen.getByRole("heading", { name: "Conversations" })).toHaveFocus()
  })

  it("says so and keeps the row when a restore fails", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    mocks.fetch.mockImplementationOnce(async () => new Response("no", { status: 403 }))
    fireEvent.click(within((await screen.findByText("Archived thread")).closest("li")!).getByRole("button", { name: "Restore" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t restore/i)
    expect(screen.getByText("Archived thread")).toBeInTheDocument()
  })
})

describe("a conversation archived from the panel", () => {
  it("drops the row at once, announces it, and moves focus to the section heading", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    archivedNow = true
    act(() => { window.dispatchEvent(new CustomEvent(CONVERSATION_ARCHIVE_CHANGED_EVENT, { detail: { conversationId: "live", archived: true } })) })
    expect(screen.queryByText("Live thread")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Conversation archived.")
    expect(screen.getByRole("heading", { name: "Conversations" })).toHaveFocus()
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1))
  })
})

describe("events that belong to another section", () => {
  it("ignores an archive of a conversation this section does not list: no announcement, no focus change", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    const before = listCalls().length
    act(() => { window.dispatchEvent(new CustomEvent(CONVERSATION_ARCHIVE_CHANGED_EVENT, { detail: { conversationId: "elsewhere", archived: true } })) })
    expect(screen.getByText("Live thread")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("")
    expect(screen.getByRole("heading", { name: "Conversations" })).not.toHaveFocus()
    expect(listCalls().length).toBe(before)
  })

  it("in the archived view, a restore from the panel drops the row and announces it", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    await screen.findByText("Archived thread")
    act(() => { window.dispatchEvent(new CustomEvent(CONVERSATION_ARCHIVE_CHANGED_EVENT, { detail: { conversationId: "gone", archived: false } })) })
    expect(screen.queryByText("Archived thread")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Conversation restored.")
  })
})

describe("the archived view's cap and row semantics", () => {
  it("says so when only the 50 most recent are shown", async () => {
    cappedNow = true
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    expect(await screen.findByText(/Showing the 50 most recent/i)).toBeInTheDocument()
  })

  it("does not claim a cap when there is none", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    await screen.findByText("Archived thread")
    expect(screen.queryByText(/Showing the 50 most recent/i)).toBeNull()
  })

  it("announces the Archived state in the row's accessible name", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByText("Live thread")
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    expect(await screen.findByRole("button", { name: /^Archived\. Archived thread/ })).toBeInTheDocument()
  })
})
