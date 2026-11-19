// TASK-195 S4: /messages fills taskCards (keyed by message id) once access to the conversation is proven.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), messages: vi.fn(), cards: vi.fn() }))
vi.mock("@/auth", () => ({ auth: () => mocks.auth() }))
vi.mock("@/lib/agent-conversations", () => ({ getAgentConversationMessages: mocks.messages }))
vi.mock("@/lib/conversation-task-cards", () => ({ loadConversationTaskCards: mocks.cards }))
import { GET } from "@/app/api/agent/conversations/[conversationId]/messages/route"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const call = () => GET(new Request(`http://localhost/api/agent/conversations/${CONV}/messages?workspaceId=ws-1`), { params: Promise.resolve({ conversationId: CONV }) })
const card = { taskId: "t1", displayId: "TASK-1", title: "Do it", status: "TODO", priority: "MEDIUM", dueDate: null, assignee: null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
})

describe("GET /messages taskCards", () => {
  it("returns the cards for the message ids it is returning", async () => {
    mocks.messages.mockResolvedValue([{ id: "m1", role: "user", content: "a" }, { id: "m2", role: "user", content: "b" }])
    mocks.cards.mockResolvedValue({ m1: card })
    const body = await (await call()).json()
    expect(mocks.cards).toHaveBeenCalledWith("ws-1", ["m1", "m2"])
    expect(body.taskCards).toEqual({ m1: card })
    expect(body.messages).toHaveLength(2)
  })

  it("reads no task data when the caller has no access (404, not an empty list)", async () => {
    mocks.messages.mockResolvedValue(null)
    expect((await call()).status).toBe(404)
    expect(mocks.cards).not.toHaveBeenCalled()
  })
})
