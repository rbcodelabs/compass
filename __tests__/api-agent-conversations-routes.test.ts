/**
 * Guard + happy-path tests for the agent rail's two read routes:
 *
 *  - GET /api/agent/conversations            (app/api/agent/conversations/route.ts)
 *  - GET /api/agent/conversations/:id/messages
 *        (app/api/agent/conversations/[conversationId]/messages/route.ts)
 *
 * Pattern after __tests__/api-agent-handoff-context-route.test.ts: mock
 * auth()/prisma rather than hitting a real DB. The mocked Prisma cannot
 * evaluate a `where`, so the authorization boundary is asserted on the query
 * the route *sends* — the `workspace.members` predicate and the `userId`
 * scope — and the denial paths are driven by what that query would return.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  agentConversation: { findMany: vi.fn(), findFirst: vi.fn() },
  agentMessage: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { GET as listConversations } from "@/app/api/agent/conversations/route"
import { GET as listMessages } from "@/app/api/agent/conversations/[conversationId]/messages/route"

const SESSION = { user: { id: "user-1" } }
const WORKSPACE_ID = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONVERSATION_ID = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"

/** The predicate that encodes "the caller is a member of this workspace". */
const MEMBERSHIP = { workspace: { members: { some: { userId: "user-1" } } } }

function listReq(query: Record<string, string>): Request {
  const params = new URLSearchParams(query)
  return new Request(`https://compass.rbcodelabs.com/api/agent/conversations?${params.toString()}`)
}

function messagesReq(conversationId: string, query: Record<string, string>) {
  const params = new URLSearchParams(query)
  return [
    new Request(
      `https://compass.rbcodelabs.com/api/agent/conversations/${conversationId}/messages?${params.toString()}`,
    ),
    { params: Promise.resolve({ conversationId }) },
  ] as const
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue(SESSION)
  mockPrisma.agentConversation.findMany.mockResolvedValue([])
  mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
})

describe("GET /api/agent/conversations", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const response = await listConversations(listReq({ workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(401)
    expect(mockPrisma.agentConversation.findMany).not.toHaveBeenCalled()
  })

  it("400s when workspaceId is missing", async () => {
    const response = await listConversations(listReq({}))
    expect(response.status).toBe(400)
    expect(mockPrisma.agentConversation.findMany).not.toHaveBeenCalled()
  })

  it("scopes to the caller and to workspaces they are a member of", async () => {
    await listConversations(listReq({ workspaceId: WORKSPACE_ID }))
    expect(mockPrisma.agentConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID, userId: "user-1", ...MEMBERSHIP },
      }),
    )
  })

  it("returns an empty list, not an error, to a non-member", async () => {
    // The membership predicate filters every row out for a non-member.
    mockPrisma.agentConversation.findMany.mockResolvedValue([])
    const response = await listConversations(listReq({ workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ conversations: [] })
  })

  it("returns only id, title and updatedAt, newest first, capped at 50", async () => {
    const updatedAt = new Date("2026-09-20T10:00:00.000Z")
    mockPrisma.agentConversation.findMany.mockResolvedValue([
      { id: CONVERSATION_ID, title: "Roadmap review", updatedAt },
    ])

    const response = await listConversations(listReq({ workspaceId: WORKSPACE_ID }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      conversations: [
        { id: CONVERSATION_ID, title: "Roadmap review", updatedAt: updatedAt.toISOString() },
      ],
    })
    expect(mockPrisma.agentConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, title: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
    )
  })
})

describe("GET /api/agent/conversations/:conversationId/messages", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(401)
    expect(mockPrisma.agentConversation.findFirst).not.toHaveBeenCalled()
  })

  it("400s when workspaceId is missing", async () => {
    const response = await listMessages(...messagesReq(CONVERSATION_ID, {}))
    expect(response.status).toBe(400)
    expect(mockPrisma.agentConversation.findFirst).not.toHaveBeenCalled()
  })

  it("404s on a malformed conversation id without querying the database", async () => {
    // The column is @db.Uuid, so Postgres would reject the cast and Prisma
    // would surface it as a 500.
    const response = await listMessages(...messagesReq("not-a-uuid", { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("404s for a non-member, and checks membership in the ownership query", async () => {
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONVERSATION_ID, workspaceId: WORKSPACE_ID, userId: "user-1", ...MEMBERSHIP },
      }),
    )
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("404s for another user's conversation in the same workspace, and reads no messages", async () => {
    // The row exists, but under another userId, so the caller-scoped lookup
    // finds nothing. Same response as "does not exist" — existence is not leaked.
    mockAuth.mockResolvedValue({ user: { id: "user-2" } })
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "user-2" }) }),
    )
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("returns only id, role, content and createdAt, oldest first", async () => {
    const createdAt = new Date("2026-09-20T10:00:00.000Z")
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID })
    mockPrisma.agentMessage.findMany.mockResolvedValue([
      { id: "m-1", role: "user", content: "hello", createdAt },
    ])

    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      messages: [{ id: "m-1", role: "user", content: "hello", createdAt: createdAt.toISOString() }],
    })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, createdAt: true },
    })
  })
})
