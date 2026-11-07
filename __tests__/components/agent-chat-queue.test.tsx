// @vitest-environment jsdom
//
// Follow-ups typed while a turn is streaming are held and sent when it settles.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/components/agent/markdown", () => ({ Markdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

import { AgentChat } from "@/components/agent/agent-chat"

const props = { workspaceId: "ws-1", basePath: "/acme/product", conversations: [], activeConversationId: null, initialMessages: [], userInitials: "RB", userId: "user-1" }
const encoder = new TextEncoder()

// An inline-stream turn that stays open until the test finishes it.
function openTurn() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  return {
    response: new Response(body, { status: 200 }),
    finish: () => {
      controller.enqueue(encoder.encode("event: result\ndata: {}\n\n"))
      controller.close()
    },
  }
}

const turnBodies = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([url]) => url === "/api/agent/turn").map(([, init]) => JSON.parse((init as RequestInit).body as string) as { message: string })

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function setup() {
  const first = openTurn()
  const turns = [first, openTurn()]
  const fetch = vi.fn(async (url: string) =>
    url === "/api/agent/turn" ? (turns.shift() ?? openTurn()).response : new Response(JSON.stringify({ agents: [], defaultAgentId: null, run: null, available: true })))
  vi.stubGlobal("fetch", fetch)
  render(<AgentChat {...props} />)
  return { fetch, first }
}

const type = (text: string) => {
  const box = screen.getByRole("textbox")
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: "Enter" })
}

it("keeps the composer editable mid-turn, queues the follow-up, and sends it when the turn ends", async () => {
  const { fetch, first } = setup()
  type("first question")
  await waitFor(() => expect(turnBodies(fetch)).toHaveLength(1))

  const box = screen.getByRole("textbox")
  expect(box).toBeEnabled()
  type("and a follow-up")
  expect(screen.getByText("and a follow-up")).toBeVisible()
  expect((box as HTMLTextAreaElement).value).toBe("")
  expect(turnBodies(fetch)).toHaveLength(1)

  await act(async () => { first.finish() })
  await waitFor(() => expect(turnBodies(fetch)).toHaveLength(2))
  expect(turnBodies(fetch)[1].message).toBe("and a follow-up")
})

it("lets the user remove a queued follow-up so it is never sent", async () => {
  const { fetch, first } = setup()
  type("first question")
  await waitFor(() => expect(turnBodies(fetch)).toHaveLength(1))
  type("never mind")
  fireEvent.click(screen.getByRole("button", { name: /remove never mind/i }))
  expect(screen.queryByText("never mind")).not.toBeInTheDocument()

  await act(async () => { first.finish() })
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
  expect(turnBodies(fetch)).toHaveLength(1)
})
