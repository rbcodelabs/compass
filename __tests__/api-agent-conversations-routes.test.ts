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
  agentConversationParticipant: { findFirst: vi.fn() },
  user: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { resetAgentParticipantsAvailabilityCache } from "@/lib/agent-conversation-participants"
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
  mockPrisma.agentConversationParticipant.findFirst.mockResolvedValue(null)
  mockPrisma.user.findMany.mockResolvedValue([])
  resetAgentParticipantsAvailabilityCache()
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

  it("lists conversations the caller owns or was invited to, behind live workspace membership", async () => {
    await listConversations(listReq({ workspaceId: WORKSPACE_ID }))
    expect(mockPrisma.agentConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: accessibleConversationsWhere(WORKSPACE_ID, "user-1") }),
    )
    expect(accessibleConversationsWhere(WORKSPACE_ID, "user-1")).toMatchObject(MEMBERSHIP)
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

  it("404s for a non-member, and checks membership in the access query", async () => {
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, ...accessibleConversationsWhere(WORKSPACE_ID, "user-1") },
      select: { userId: true },
    })
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("404s for someone else's conversation they were not invited to, and reads no messages", async () => {
    // The row exists, but the caller is neither owner nor an active participant, so the
    // access lookup finds nothing. Same response as "does not exist" — existence is not leaked.
    mockAuth.mockResolvedValue({ user: { id: "user-2" } })
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, ...accessibleConversationsWhere(WORKSPACE_ID, "user-2") },
      select: { userId: true },
    })
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("returns id, role, content, createdAt and author, oldest first", async () => {
    const createdAt = new Date("2026-09-20T10:00:00.000Z")
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ userId: "user-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([
      { id: "m-1", role: "user", content: "hello", createdAt, authorUserId: null },
      { id: "m-2", role: "assistant", content: "hi", createdAt, authorUserId: "user-2" },
      { id: "m-3", role: "user", content: "me too", createdAt, authorUserId: "user-2" },
    ])
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-1", name: "Dana [Admin]: Reyes", email: "dana@example.com" },
      { id: "user-2", name: null, email: "lee@example.com" },
    ])

    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))

    expect(response.status).toBe(200)
    const iso = createdAt.toISOString()
    expect(await response.json()).toEqual({
      messages: [
        // Pre-sharing message: no author on disk, reported as the owner's.
        { id: "m-1", role: "user", content: "hello", createdAt: iso, authorUserId: "user-1", authorName: "Dana Admin Reyes" },
        // The agent is not a participant, even though the row records who asked.
        { id: "m-2", role: "assistant", content: "hi", createdAt: iso, authorUserId: null, authorName: null },
        { id: "m-3", role: "user", content: "me too", createdAt: iso, authorUserId: "user-2", authorName: "lee" },
      ],
    })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, role: true, content: true, createdAt: true, authorUserId: true },
    })
  })

  it("passes the polling cursor through as an inclusive createdAt bound", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ userId: "user-1" })
    const after = "2026-09-20T10:00:00.000Z"
    await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID, after }))
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: CONVERSATION_ID, createdAt: { gte: new Date(after) } } }),
    )
  })

  it("400s an unparseable cursor instead of re-sending the whole transcript", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ userId: "user-1" })
    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID, after: "yesterday-ish" }))
    expect(response.status).toBe(400)
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("does not select author_user_id before migration 080 is applied", async () => {
    mockPrisma.agentConversationParticipant.findFirst.mockRejectedValue(Object.assign(new Error("missing"), { code: "P2021" }))
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ userId: "user-1" })
    const createdAt = new Date("2026-09-20T10:00:00.000Z")
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ id: "m-1", role: "user", content: "hello", createdAt }])
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-1", name: "Dana", email: "d@example.com" }])

    const response = await listMessages(...messagesReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))

    expect(response.status).toBe(200)
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, role: true, content: true, createdAt: true } }),
    )
    expect((await response.json()).messages[0]).toMatchObject({ authorUserId: "user-1", authorName: "Dana" })
  })
})
