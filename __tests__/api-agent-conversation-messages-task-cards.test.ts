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

  it("looks cards up only for person-authored comment-kind messages, never agent, plan or system rows", async () => {
    mocks.messages.mockResolvedValue([
      { id: "u1", role: "user", messageKind: "COMMENT" }, { id: "u2", role: "user", messageKind: null }, { id: "u3", role: "user", messageKind: "MESSAGE" },
      { id: "a1", role: "assistant", messageKind: null }, { id: "p1", role: "user", messageKind: "PLAN_PROPOSAL" }, { id: "s1", role: "user", messageKind: "SYSTEM_RESOLUTION" },
    ].map((m) => ({ ...m, content: "x" })))
    mocks.cards.mockResolvedValue({})
    await call()
    expect(mocks.cards).toHaveBeenCalledWith("ws-1", ["u1", "u2", "u3"])
  })

  it("caps the lookup at the 500 newest eligible messages", async () => {
    mocks.messages.mockResolvedValue(Array.from({ length: 700 }, (_, i) => ({ id: `m${i}`, role: "user", messageKind: "COMMENT", content: "x" })))
    mocks.cards.mockResolvedValue({})
    await call()
    const ids = mocks.cards.mock.calls[0][1] as string[]
    expect(ids).toHaveLength(500)
    expect(ids[0]).toBe("m200")
    expect(ids[499]).toBe("m699")
  })

  it("reads no task data when the caller has no access (404, not an empty list)", async () => {
    mocks.messages.mockResolvedValue(null)
    expect((await call()).status).toBe(404)
    expect(mocks.cards).not.toHaveBeenCalled()
  })
})
