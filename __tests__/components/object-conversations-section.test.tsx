// @vitest-environment jsdom
import React, { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), remove: vi.fn(), open: vi.fn() }))
vi.mock("@/components/panels/conversation-panel", () => ({ useConversationPanelOptional: () => ({ workspaceId: "workspace", orgSlug: "acme", workspaceSlug: "core", openConversationInPanel: mocks.open, startNewConversationInPanel: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: mocks.remove }))
vi.mock("@/components/docs/mention-editor", () => ({
  MentionEditor: ({ initialValue = "", onChange, onSubmitShortcut, disabled, ariaLabel }: { initialValue?: string; onChange: (value: string) => void; onSubmitShortcut: () => void; disabled: boolean; ariaLabel: string }) => {
    const [value, setValue] = useState(initialValue)
    return <textarea aria-label={ariaLabel} value={value} disabled={disabled} onChange={e => { setValue(e.target.value); onChange(e.target.value) }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onSubmitShortcut() } }} />
  },
}))
import { ObjectConversationsSection } from "@/components/conversations/object-conversations-section"

const item = { id: "conversation", title: "Team thread", summary: null, status: "OPEN", visibility: "WORKSPACE", agentMode: "MENTION_ONLY", messageCount: 1, updatedAt: "2026-11-18T00:00:00Z", anchored: true, links: [] }
const list = (items: unknown[] = [item]) => Response.json({ items })
const mount = () => render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
const draft = "  Keep [Ada](mention:user:ada)\nexactly as typed.  "

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", mocks.fetch); mocks.fetch.mockImplementation(async () => list()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("object conversation recovery", () => {
  it("shows a load error, never an empty state, and retries deliberately", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(list())
    mount()
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load conversations/i)
    expect(screen.queryByText(/No conversations on this item yet/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("button", { name: /Team thread/ })).toBeVisible()
  })

  it.each(["rejection", "transport", "malformed"])("preserves the exact serialized draft after %s and never automatically resends", async failure => {
    mount()
    await screen.findByRole("button", { name: /Team thread/ })
    const editor = screen.getByRole("textbox", { name: "Start a conversation" })
    fireEvent.change(editor, { target: { value: draft } })
    if (failure === "transport") mocks.fetch.mockRejectedValueOnce(new Error("connection lost"))
    else mocks.fetch.mockResolvedValueOnce(failure === "rejection" ? new Response(null, { status: 400 }) : new Response("not json", { headers: { "content-type": "application/json" } }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByRole("alert")).toBeVisible()
    expect(editor).toHaveValue(draft)
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    if (failure !== "rejection") {
      expect(screen.getByRole("alert")).toHaveTextContent("We couldn’t confirm whether this was sent. Check conversations before retrying.")
      expect(screen.getByRole("button", { name: "Refresh conversations" })).toBeVisible()
    }
    expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled()
  })

  it("clears an accepted send even when the list refresh fails, without inviting resend", async () => {
    mount(); await screen.findByRole("button", { name: /Team thread/ })
    const editor = screen.getByRole("textbox", { name: "Start a conversation" })
    fireEvent.change(editor, { target: { value: draft } })
    mocks.fetch.mockResolvedValueOnce(Response.json({ conversationId: "new-conversation" })).mockResolvedValueOnce(new Response(null, { status: 503 }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a conversation" })).toHaveValue(""))
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load conversations/i)
    expect(screen.getByRole("button", { name: /Team thread/ })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Retry send" })).not.toBeInTheDocument()
  })

  it("offers removal only for automatic links, confirms it, and keeps anchored overlap after refresh", async () => {
    mocks.fetch.mockResolvedValueOnce(list([{ ...item, links: [{ linkId: "auto", kind: "CREATED", auto: true }, { linkId: "manual", kind: "MENTIONS", auto: false }] }]))
    mocks.remove.mockResolvedValue({ ok: true, removed: true })
    mount()
    await screen.findByRole("button", { name: /^Team thread/ })
    expect(screen.getByText("On this item")).toBeVisible()
    expect(screen.getByText("Created here")).toBeVisible()
    expect(screen.getByText("Mentioned")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Remove Mentioned link to Team thread" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove Created here link to Team thread" }))
    expect(screen.getByText("The conversation and this item will be kept.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Remove Created here link to Team thread" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("acme", "core", "auto"))
    expect(await screen.findByRole("status")).toHaveTextContent(/link removed/i)
    expect(screen.getByRole("button", { name: /Team thread/ })).toBeVisible()
  })

  it("refreshes uncertain outcomes with GET only and preserves warning and exact draft", async () => {
    mount(); await screen.findByRole("button", { name: /Team thread/ })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } })
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(list())
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(await screen.findByRole("button", { name: "Refresh conversations" }))
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3))
    expect(screen.getByRole("textbox")).toHaveValue(draft)
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn’t confirm whether this was sent.")
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
  })

  it("allows only one send across repeated Enter and click while pending", async () => {
    mount(); await screen.findByRole("button", { name: /Team thread/ })
    const editor = screen.getByRole("textbox")
    fireEvent.change(editor, { target: { value: draft } })
    let resolve!: (value: Response) => void
    mocks.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    fireEvent.keyDown(editor, { key: "Enter" }); fireEvent.keyDown(editor, { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: "Sending…" }))
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled()
    await act(async () => resolve(Response.json({ conversationId: "accepted" })))
  })

  it("ignores an old target's delayed list response", async () => {
    let resolve!: (value: Response) => void
    mocks.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done })).mockResolvedValueOnce(list([{ ...item, title: "New target" }]))
    const view = mount()
    view.rerender(<ObjectConversationsSection targetType="TASK" targetId="new-task" />)
    await screen.findByRole("button", { name: /New target/ })
    await act(async () => resolve(list([{ ...item, title: "Old target" }])))
    expect(screen.queryByRole("button", { name: /Old target/ })).not.toBeInTheDocument()
  })

  it("does not clear a new target's draft or open an old panel after delayed acceptance JSON", async () => {
    const view = mount(); await screen.findByRole("button", { name: /Team thread/ })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } })
    let resolve!: (value: unknown) => void
    mocks.fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => new Promise(done => { resolve = done }) })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(resolve).toBeTypeOf("function"))
    view.rerender(<ObjectConversationsSection targetType="TASK" targetId="new-task" />)
    await screen.findByRole("button", { name: /Team thread/ })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New target draft" } })
    await act(async () => resolve({ conversationId: "old-conversation" }))
    expect(screen.getByRole("textbox")).toHaveValue("New target draft")
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each([
    ["acknowledged", 'event: status\ndata: {"phase":"booting","conversationId":"streamed"}\n\n', true],
    ["malformed", "event: status\ndata: not json\n\n", false],
    ["ended without acceptance", "event: status\ndata: {\"phase\":\"preparing\"}\n\n", false],
  ] as const)("handles an %s legacy stream without losing an uncertain draft", async (_name, body, accepted) => {
    mount(); await screen.findByRole("button", { name: /Team thread/ })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } })
    mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    if (accepted) {
      await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("streamed", expect.anything()))
      expect(screen.getByRole("textbox")).toHaveValue("")
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("We couldn’t confirm whether this was sent.")
      expect(screen.getByRole("textbox")).toHaveValue(draft)
    }
  })

  it("does not resurrect a removed automatic link from an older refresh", async () => {
    const linked = { ...item, links: [{ linkId: "auto", kind: "CREATED", auto: true }] }
    mocks.fetch.mockResolvedValueOnce(list([linked]))
    mocks.remove.mockResolvedValue({ ok: true, removed: true })
    mount(); await screen.findByRole("button", { name: /^Team thread/ })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } })
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const refresh = await screen.findByRole("button", { name: "Refresh conversations" })
    let resolve!: (value: Response) => void
    mocks.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    fireEvent.click(refresh)
    fireEvent.click(screen.getByRole("button", { name: "Remove Created here link to Team thread" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link removed"))
    await act(async () => resolve(list([linked])))
    expect(screen.queryByText("Created here")).not.toBeInTheDocument()
    expect(screen.getByText("On this item")).toBeVisible()
  })

  it("keeps failed removal local, supports retry, and focuses the section after success", async () => {
    mocks.fetch.mockResolvedValueOnce(list([{ ...item, links: [{ linkId: "auto", kind: "CREATED", auto: true }] }]))
    mocks.remove.mockResolvedValueOnce({ ok: false, error: "unavailable" }).mockResolvedValueOnce({ ok: true, removed: true })
    mount(); await screen.findByRole("button", { name: /^Team thread/ })
    fireEvent.click(screen.getByRole("button", { name: "Remove Created here link to Team thread" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not remove the link/i)
    expect(screen.getByText("Created here")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry removal" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link removed"))
    expect(screen.getByRole("heading", { name: "Conversations" })).toHaveFocus()
  })
})
