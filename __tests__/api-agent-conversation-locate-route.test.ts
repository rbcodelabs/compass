/** TASK-195 S3: GET /api/agent/conversations/locate. Thin route: auth, input validation, and a 404 that says nothing. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), locate: vi.fn() }))
vi.mock("@/auth", () => ({ auth: () => mocks.auth() }))
vi.mock("@/lib/db", () => ({ default: () => ({ marker: "prisma" }) }))
vi.mock("@/lib/conversation-locate", () => ({ locateConversationMessage: (...args: unknown[]) => mocks.locate(...args) }))

import { GET } from "@/app/api/agent/conversations/locate/route"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const MSG = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const call = (query = `?workspaceId=${WS}&messageId=${MSG}`) => GET(new Request(`https://x.test/api/agent/conversations/locate${query}`))

const located = { conversationId: "c1", messageId: MSG, isRoot: false, targetType: "OPPORTUNITY", targetId: "t1", status: "OPEN", archived: false }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
})

describe("GET /api/agent/conversations/locate", () => {
  it("401s without a session and never looks anything up", async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    expect(mocks.locate).not.toHaveBeenCalled()
  })

  it("400s without a workspace or a message id", async () => {
    expect((await call(`?messageId=${MSG}`)).status).toBe(400)
    expect((await call(`?workspaceId=${WS}`)).status).toBe(400)
    expect(mocks.locate).not.toHaveBeenCalled()
  })

  it("404s a malformed id (same as unknown) without touching the database", async () => {
    expect((await call(`?workspaceId=${WS}&messageId=not-a-uuid`)).status).toBe(404)
    expect((await call(`?workspaceId=nope&messageId=${MSG}`)).status).toBe(404)
    expect(mocks.locate).not.toHaveBeenCalled()
  })

  it("answers with the located conversation, using the session user and never a client-supplied one", async () => {
    mocks.locate.mockResolvedValue(located)
    const response = await call(`?workspaceId=${WS}&messageId=${MSG}&userId=attacker`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(located)
    expect(mocks.locate).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, userId: "user-1", messageId: MSG })
  })

  it("404s with an empty, uniform body when nothing is located, so existence, titles and text are never revealed", async () => {
    mocks.locate.mockResolvedValue(null)
    const unreadable = await call()
    const unknownBody = await unreadable.text()
    expect(unreadable.status).toBe(404)
    expect(unknownBody).toBe("Not found")
    const malformed = await call(`?workspaceId=${WS}&messageId=not-a-uuid`)
    expect(await malformed.text()).toBe(unknownBody)
  })

  it("does not cache the answer", async () => {
    mocks.locate.mockResolvedValue(located)
    expect((await call()).headers.get("cache-control")).toMatch(/no-store/)
  })
})
