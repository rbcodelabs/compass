import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))
const mockEdit = vi.fn()
vi.mock("@/lib/conversation-messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/conversation-messages")>()),
  editConversationMessage: (...args: unknown[]) => mockEdit(...args),
}))

import { PATCH } from "@/app/api/agent/conversations/[conversationId]/messages/[messageId]/route"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MSG = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"

function call(over: { conversationId?: string; messageId?: string; query?: string; body?: unknown } = {}) {
  const conversationId = over.conversationId ?? CONV
  const messageId = over.messageId ?? MSG
  const query = over.query ?? `?workspaceId=${WS}`
  return PATCH(
    new Request(`https://x.test/api/agent/conversations/${conversationId}/messages/${messageId}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof over.body === "string" ? over.body : JSON.stringify(over.body ?? { content: "hi" }),
    }),
    { params: Promise.resolve({ conversationId, messageId }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
})

describe("PATCH /api/agent/conversations/:id/messages/:messageId", () => {
  it("401s without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it("400s without a workspace, on bad JSON, and on a non-string body", async () => {
    expect((await call({ query: "" })).status).toBe(400)
    expect((await call({ body: "{nope" })).status).toBe(400)
    expect((await call({ body: { content: 5 } })).status).toBe(400)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it("404s malformed ids without calling the service", async () => {
    expect((await call({ conversationId: "nope" })).status).toBe(404)
    expect((await call({ messageId: "nope" })).status).toBe(404)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it("passes the session user, never a client-supplied one, to the service", async () => {
    mockEdit.mockResolvedValue({ ok: true, message: { id: MSG, content: "hi", editedAt: new Date(0), canEdit: true } })
    const response = await call({ body: { content: "hi", userId: "attacker", canEdit: true } })
    expect(response.status).toBe(200)
    expect(mockEdit).toHaveBeenCalledWith({ conversationId: CONV, messageId: MSG, workspaceId: WS, userId: "user-1", content: "hi" })
    expect((await response.json()).message).toMatchObject({ id: MSG, content: "hi", canEdit: true })
  })
  it.each([[403], [404], [400]])("maps a service %i to the same status with a generic body", async (status) => {
    mockEdit.mockResolvedValue({ ok: false, status, error: "Nope." })
    const response = await call()
    expect(response.status).toBe(status)
    expect(await response.text()).toBe("Nope.")
  })
})
