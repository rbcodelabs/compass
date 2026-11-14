/**
 * Guard + happy-path tests for the agent board's two routes:
 *
 *  - GET  /api/agent/board                              (app/api/agent/board/route.ts)
 *  - POST /api/agent/conversations/:id/review           (app/api/agent/conversations/[conversationId]/review/route.ts)
 *
 * Auth and Prisma are mocked, so the authorization boundary is asserted on the queries the
 * routes send and the denial paths are driven by what the access query would return.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  agentConversation: { findMany: vi.fn(), findFirst: vi.fn() },
  agentConversationReview: { findMany: vi.fn(), upsert: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { GET as getBoard } from "@/app/api/agent/board/route"
import { GET as getBoardStream } from "@/app/api/agent/board/stream/route"
import { POST as postReview } from "@/app/api/agent/conversations/[conversationId]/review/route"

const SESSION = { user: { id: "user-1" } }
const WORKSPACE_ID = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONVERSATION_ID = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"

function boardReq(query: Record<string, string>) {
  return new Request(`https://compass.rbcodelabs.com/api/agent/board?${new URLSearchParams(query)}`)
}

function reviewReq(conversationId: string, query: Record<string, string>) {
  return [
    new Request(`https://compass.rbcodelabs.com/api/agent/conversations/${conversationId}/review?${new URLSearchParams(query)}`, { method: "POST" }),
    { params: Promise.resolve({ conversationId }) },
  ] as const
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue(SESSION)
  mockPrisma.agentConversation.findMany.mockResolvedValue([])
  mockPrisma.agentConversation.findFirst.mockResolvedValue({ userId: "owner" })
  mockPrisma.agentConversationReview.findMany.mockResolvedValue([])
  mockPrisma.agentConversationReview.upsert.mockResolvedValue({})
})

describe("GET /api/agent/board", () => {
  it("401s without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await getBoard(boardReq({ workspaceId: WORKSPACE_ID }))).status).toBe(401)
    expect(mockPrisma.agentConversation.findMany).not.toHaveBeenCalled()
  })

  it("400s when workspaceId is missing or not a uuid (it would otherwise reach Postgres as a failed cast)", async () => {
    expect((await getBoard(boardReq({}))).status).toBe(400)
    expect((await getBoard(boardReq({ workspaceId: "nope" }))).status).toBe(400)
    expect(mockPrisma.agentConversation.findMany).not.toHaveBeenCalled()
  })

  it("lists behind live workspace membership and reads only the caller's reviews", async () => {
    mockPrisma.agentConversation.findMany.mockResolvedValue([
      {
        id: CONVERSATION_ID,
        title: "Hello",
        updatedAt: new Date("2026-10-05T12:00:00.000Z"),
        _count: { messages: 2 },
        runs: [],
      },
    ])
    const response = await getBoard(boardReq({ workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      cards: [{ id: CONVERSATION_ID, title: "Hello", messageCount: 2, runStatus: null, lastActivityAt: "2026-10-05T12:00:00.000Z", reviewedAt: null }],
    })
    expect(mockPrisma.agentConversation.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workspace: { members: { some: { userId: "user-1" } } },
    })
    expect(mockPrisma.agentConversationReview.findMany.mock.calls[0][0].where).toMatchObject({ userId: "user-1" })
  })
})

describe("POST /api/agent/conversations/:id/review", () => {
  it("401s without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await postReview(...reviewReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))).status).toBe(401)
    expect(mockPrisma.agentConversationReview.upsert).not.toHaveBeenCalled()
  })

  it("400s without a workspace and 404s a malformed conversation id, writing nothing", async () => {
    expect((await postReview(...reviewReq(CONVERSATION_ID, {}))).status).toBe(400)
    expect((await postReview(...reviewReq("not-a-uuid", { workspaceId: WORKSPACE_ID }))).status).toBe(404)
    expect(mockPrisma.agentConversationReview.upsert).not.toHaveBeenCalled()
  })

  it("404s, and writes nothing, for a conversation the caller cannot access (not 403: existence is not leaked)", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const response = await postReview(...reviewReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(404)
    expect(mockPrisma.agentConversationReview.upsert).not.toHaveBeenCalled()
    expect(mockPrisma.agentConversation.findFirst.mock.calls[0][0].where).toMatchObject({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      workspace: { members: { some: { userId: "user-1" } } },
    })
  })

  it("records the review for the caller only", async () => {
    const response = await postReview(...reviewReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))
    expect(response.status).toBe(200)
    expect(mockPrisma.agentConversationReview.upsert.mock.calls[0][0].where).toEqual({
      conversationId_userId: { conversationId: CONVERSATION_ID, userId: "user-1" },
    })
  })

  it("503s while the reviews migration is unapplied", async () => {
    mockPrisma.agentConversationReview.upsert.mockRejectedValue(Object.assign(new Error("no table"), { code: "P2021" }))
    expect((await postReview(...reviewReq(CONVERSATION_ID, { workspaceId: WORKSPACE_ID }))).status).toBe(503)
  })
})

describe("GET /api/agent/board/stream", () => {
  it("401s without a session and 400s without a valid workspaceId", async () => {
    mockAuth.mockResolvedValueOnce(null)
    expect((await getBoardStream(new Request(`https://compass.rbcodelabs.com/api/agent/board/stream?workspaceId=${WORKSPACE_ID}`))).status).toBe(401)
    expect((await getBoardStream(new Request("https://compass.rbcodelabs.com/api/agent/board/stream?workspaceId=bad"))).status).toBe(400)
  })

  it("emits an initial SSE snapshot frame and terminates cleanly on client abort", async () => {
    mockPrisma.agentConversation.findMany.mockResolvedValue([
      {
        id: CONVERSATION_ID,
        title: "Streaming thread",
        updatedAt: new Date("2026-10-05T12:00:00.000Z"),
        _count: { messages: 1 },
        runs: [{ status: "RUNNING", currentActivity: "Searching docs", statusChangedAt: new Date("2026-10-05T12:01:00.000Z") }],
      },
    ])

    const controller = new AbortController()
    const response = await getBoardStream(
      new Request(`https://compass.rbcodelabs.com/api/agent/board/stream?workspaceId=${WORKSPACE_ID}`, {
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/event-stream")

    const reader = response.body!.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain("event: snapshot")
    expect(text).toContain("Streaming thread")
    expect(text).toContain("Searching docs")

    controller.abort()
    await reader.cancel()
  })
})
