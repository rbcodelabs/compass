// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/components/agent/markdown", () => ({ Markdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
import { AgentChat } from "@/components/agent/agent-chat"
const props = { workspaceId: "workspace", basePath: "/org/workspace", conversations: [], activeConversationId: "conversation", initialMessages: [], userInitials: "PM" }
beforeEach(() => { vi.clearAllMocks(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it("shows persisted successful edits even with no assistant message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "SUCCEEDED", interviewId: "interview", receipt: { changedFields: ["description"], before: { description: "Old wording" }, after: { description: "New wording" }, targetUrl: "/org/workspace/opportunities/item" } }))))
  render(<AgentChat {...props} />)
  expect(await screen.findByText("Item updated")).toBeVisible()
  expect(screen.getByText("description")).toBeVisible()
  expect(screen.getByText("Old wording")).toBeVisible()
  expect(screen.getByText("New wording")).toBeVisible()
  expect(screen.getByRole("link", { name: "Open updated item" })).toHaveAttribute("href", "/org/workspace/opportunities/item")
})
it("requires server permission for terminal follow-up chat and marks it as continuation", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("/processing") ? new Response(JSON.stringify({ status: "SUCCEEDED", canContinue: true, interviewId: "interview", receipt: { changedFields: [], targetUrl: "/item" } })) : new Response("event: result\ndata: {}\n\n"))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Explain the change" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/agent/turn", expect.objectContaining({ body: expect.stringContaining('"continue":true') })))
})
it("does not dispatch when processing status cannot be checked", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  expect(await screen.findByText(/Unable to check processing status/)).toBeVisible()
  expect(screen.getByRole("textbox")).toBeDisabled()
  expect(fetch.mock.calls).toHaveLength(1)
})
it("does not dispatch a duplicate request for a running interview", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "RUNNING", interviewId: "interview", receipt: null })))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  expect(await screen.findByText(/Updating your item/)).toBeVisible()
  expect(fetch.mock.calls.every(([url]) => url.includes("/processing"))).toBe(true)
})
it("keeps normal conversation composer available when no interview is linked", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })))
  render(<AgentChat {...props} />)
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
})
it("shows no-change receipts rather than claiming an edit", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "SUCCEEDED", interviewId: "interview", receipt: { changedFields: [], targetUrl: "/org/workspace/item" } }))))
  render(<AgentChat {...props} />)
  expect(await screen.findByText("No changes saved")).toBeVisible()
  expect(screen.queryByText("Item updated")).not.toBeInTheDocument()
})
it("automatically starts pending handoff once", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("/processing") ? new Response(JSON.stringify({ status: "PENDING", interviewId: "interview", receipt: null })) : new Response("event: result\ndata: {}\n\n"))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1))
})
it("retries failed processing only after an explicit click", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("/processing") ? new Response(JSON.stringify({ status: "FAILED", interviewId: "interview", receipt: null })) : new Response("event: result\ndata: {}\n\n"))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  fireEvent.click(await screen.findByRole("button", { name: "Retry update" }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/agent/turn", expect.objectContaining({ body: expect.stringContaining('"retry":true') })))
  expect(fetch.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1)
})
it("aborts a previous conversation stream and permits sending in the new conversation", async () => {
  let release!: (response: Response) => void
  let oldSignal: AbortSignal | undefined
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/processing")) return new Response("", { status: 404 })
    if (String(init?.body).includes('"conversationId":"conversation"')) {
      oldSignal = init?.signal as AbortSignal
      return new Promise<Response>(resolve => { release = resolve })
    }
    return new Response('event: result\ndata: {"text":"New conversation reply"}\n\n')
  })
  vi.stubGlobal("fetch", fetch)
  const view = render(<AgentChat {...props} />)
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old message" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  await waitFor(() => expect(oldSignal).toBeDefined())
  view.rerender(<AgentChat {...props} activeConversationId="next" />)
  expect(oldSignal?.aborted).toBe(true)
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "New message" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(await screen.findByText("New conversation reply")).toBeVisible()
  release(new Response('event: result\ndata: {"text":"Old conversation reply"}\n\n'))
  await waitFor(() => expect(screen.queryByText("Old conversation reply")).not.toBeInTheDocument())
})
