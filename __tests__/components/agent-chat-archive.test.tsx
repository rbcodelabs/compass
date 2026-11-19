// @vitest-environment jsdom
//
// TASK-195 S2: the Archive conversation action in a shared conversation's header, its in-app confirm, and what a
// participant sees when the thread is archived under them. There is no per-message delete.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"
import { CONVERSATION_ARCHIVE_CHANGED_EVENT } from "@/components/conversations/archive-events"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MESSAGES = [{ id: "m1", role: "user" as const, content: "hello team", authorUserId: "user-1", authorName: "Rick", canEdit: true, canDelete: false }]

function props(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1", basePath: "/acme/product", conversations: [{ id: CONV, title: "Thread" }], activeConversationId: CONV,
    initialMessages: MESSAGES, userInitials: "RB", userId: "user-1", initialVisibility: "WORKSPACE" as const, canArchive: true, ...over,
  }
}
const patches = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === "PATCH" && String(url).startsWith(`/api/agent/conversations/${CONV}?`) ? Response.json({ archived: true, changed: true }) : new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("Archive conversation action", () => {
  it("is offered next to Resolve only when the server said the caller may archive", async () => {
    const { rerender } = render(<AgentChat {...props()} />)
    expect(await screen.findByRole("button", { name: "Archive conversation" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument()
    rerender(<AgentChat {...props({ canArchive: false })} />)
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull()
  })

  it("never offers a per-message delete, even if a row claims canDelete", async () => {
    render(<AgentChat {...props({ initialMessages: [{ ...MESSAGES[0], canDelete: true }] })} />)
    await screen.findByTestId("conversation-message")
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  })

  it("asks in an accessible alert dialog with reversible, entity-neutral copy", async () => {
    render(<AgentChat {...props()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveAccessibleName(/archive this conversation/i)
    expect(dialog).toHaveAccessibleDescription(/restore it from Archived/i)
    expect(dialog.textContent).not.toMatch(/cannot be undone|permanent|delete/i)
    expect(patches(fetchMock)).toHaveLength(0)
  })

  it("Cancel closes the dialog without a request", async () => {
    render(<AgentChat {...props()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(patches(fetchMock)).toHaveLength(0)
  })

  it("confirming archives, announces the change and hands control back to the panel exactly once", async () => {
    const onArchived = vi.fn()
    const heard: unknown[] = []
    window.addEventListener(CONVERSATION_ARCHIVE_CHANGED_EVENT, (e) => heard.push((e as CustomEvent).detail), { once: true })
    render(<AgentChat {...props({ onConversationArchived: onArchived })} />)
    fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }))
    await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1))
    const [url, init] = patches(fetchMock)[0]!
    expect(url).toBe(`/api/agent/conversations/${CONV}?workspaceId=ws-1`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ archived: true })
    expect(heard).toEqual([{ conversationId: CONV, archived: true }])
  })

  it("keeps the thread open and says so when the archive fails", async () => {
    const onArchived = vi.fn()
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PATCH" ? new Response("no", { status: 403 }) : new Response("{}"))
    render(<AgentChat {...props({ onConversationArchived: onArchived })} />)
    fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }))
    expect(await screen.findByText(/couldn.t archive this conversation/i)).toBeInTheDocument()
    expect(onArchived).not.toHaveBeenCalled()
  })
})

const quietFetch = (turn: () => Response) => async (url: string, init?: RequestInit) =>
  url === "/api/agent/turn"
    ? turn()
    : init?.method === "PATCH"
      ? Response.json({ archived: false, changed: true })
      // No interview processing on this thread: a 404 there clears the composer block.
      : String(url).includes("/processing")
        ? new Response(null, { status: 404 })
        : Response.json({ agents: [], defaultAgentId: null, run: null, available: false })

describe("archived under another participant", () => {
  it("turns into a read-only archived state, not the removed-access wording, when the server says archived", async () => {
    fetchMock.mockImplementation(quietFetch(() => new Response("Conversation archived.", { status: 404, headers: { "x-conversation-state": "archived" } })))
    render(<AgentChat {...props({ canArchive: false })} />)
    const box = await screen.findByRole("textbox")
    fireEvent.change(box, { target: { value: "still there?" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(await screen.findByText(/archived and read-only/i)).toBeInTheDocument()
    expect(screen.queryByText(/no longer have access/i)).toBeNull()
    expect(screen.getByRole("textbox")).toBeDisabled()
  })

  it("does not mistake an ordinary 404 (workspace gone, deploy skew) for an archive", async () => {
    fetchMock.mockImplementation(quietFetch(() => new Response("Workspace not found or access denied.", { status: 404 })))
    render(<AgentChat {...props({ canArchive: false })} />)
    const box = await screen.findByRole("textbox")
    fireEvent.change(box, { target: { value: "hello" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(await screen.findByText(/Workspace not found or access denied/)).toBeInTheDocument()
    expect(screen.queryByText(/archived and read-only/i)).toBeNull()
  })
})

describe("an archived thread opened by id", () => {
  it("is read-only: no Archive action, a neutral banner, a disabled composer, and a Restore action for those who may", async () => {
    fetchMock.mockImplementation(quietFetch(() => new Response("", { status: 200 })))
    render(<AgentChat {...props({ initialArchived: true, canArchive: false, canRestore: true })} />)
    expect(await screen.findByText(/archived and read-only/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull()
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
    expect(screen.queryByText(/no longer have access/i)).toBeNull()
  })

  it("offers no Restore to someone without the right", async () => {
    fetchMock.mockImplementation(quietFetch(() => new Response("", { status: 200 })))
    render(<AgentChat {...props({ initialArchived: true, canArchive: false, canRestore: false })} />)
    await screen.findByText(/archived and read-only/i)
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
  })

  it("Restore re-enables the thread, tells the section, and brings Archive back", async () => {
    fetchMock.mockImplementation(quietFetch(() => new Response("", { status: 200 })))
    const heard: unknown[] = []
    window.addEventListener(CONVERSATION_ARCHIVE_CHANGED_EVENT, (e) => heard.push((e as CustomEvent).detail), { once: true })
    render(<AgentChat {...props({ initialArchived: true, canArchive: true, canRestore: true })} />)
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }))
    await waitFor(() => expect(screen.queryByText(/archived and read-only/i)).toBeNull())
    expect(JSON.parse((patches(fetchMock)[0]![1] as RequestInit).body as string)).toEqual({ archived: false })
    expect(heard).toEqual([{ conversationId: CONV, archived: false }])
    expect(screen.getByRole("textbox")).toBeEnabled()
  })
})
