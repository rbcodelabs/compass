/**
 * HTTP mapping for the participants routes. The rules themselves
 * are covered in __tests__/lib/agent-conversation-participants.test.ts; here the lib is
 * mocked and we assert status codes, guards and what the routes pass through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))

const mockList = vi.fn()
const mockAdd = vi.fn()
const mockRemove = vi.fn()
vi.mock("@/lib/agent-conversation-participants", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-conversation-participants")>(
    "@/lib/agent-conversation-participants"
  )
  return {
    ...actual,
    listConversationParticipants: (...a: unknown[]) => mockList(...a),
    addConversationParticipant: (...a: unknown[]) => mockAdd(...a),
    removeConversationParticipant: (...a: unknown[]) => mockRemove(...a),
  }
})

import { AgentParticipantError } from "@/lib/agent-conversation-participants"
import { GET, POST } from "@/app/api/agent/conversations/[conversationId]/participants/route"
import { DELETE } from "@/app/api/agent/conversations/[conversationId]/participants/[userId]/route"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const OTHER = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"

const ctx = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ conversationId: CONV, userId: "", ...extra }) })
const url = (query = `workspaceId=${WS}`) => `http://test/api/agent/conversations/${CONV}/participants?${query}`
const post = (body: unknown, query?: string) =>
  POST(new Request(url(query), { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx())

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("GET participants", () => {
  it("401s without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await GET(new Request(url()), ctx())).status).toBe(401)
    expect(mockList).not.toHaveBeenCalled()
  })

  it("400s without a workspaceId and 404s on malformed ids", async () => {
    expect((await GET(new Request(url("")), ctx())).status).toBe(400)
    expect((await GET(new Request(url("workspaceId=nope")), ctx())).status).toBe(404)
    expect(
      (await GET(new Request(url()), { params: Promise.resolve({ conversationId: "nope" }) })).status
    ).toBe(404)
    expect(mockList).not.toHaveBeenCalled()
  })

  it("404s when the lib says the caller has no access", async () => {
    mockList.mockResolvedValue(null)
    expect((await GET(new Request(url()), ctx())).status).toBe(404)
  })

  it("returns the roster uncached, and asks for candidates only with ?candidates=1", async () => {
    const body = { available: true, viewerRole: "OWNER", participants: [], shareable: true }
    mockList.mockResolvedValue(body)
    const res = await GET(new Request(url()), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual(body)
    expect(mockList.mock.calls[0][1]).toEqual({
      conversationId: CONV, workspaceId: WS, actorUserId: "user-1", includeCandidates: false,
    })
    await GET(new Request(url(`workspaceId=${WS}&candidates=1`)), ctx())
    expect(mockList.mock.calls[1][1].includeCandidates).toBe(true)
  })
})

describe("POST participants", () => {
  it("401s, 400s and 404s before touching the lib", async () => {
    mockAuth.mockResolvedValueOnce(null)
    expect((await post({ userId: OTHER })).status).toBe(401)
    expect((await post({ userId: OTHER }, "")).status).toBe(400)
    expect((await post({ userId: OTHER }, "workspaceId=nope")).status).toBe(404)
    expect((await post({ userId: "not-a-uuid" })).status).toBe(400)
    expect((await post("not json")).status).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it("answers 201 when someone was added and 200 for an idempotent no-op", async () => {
    mockAdd.mockResolvedValueOnce({ added: true }).mockResolvedValueOnce({ added: false })
    expect((await post({ userId: OTHER })).status).toBe(201)
    expect((await post({ userId: OTHER })).status).toBe(200)
    expect(mockAdd.mock.calls[0][1]).toEqual({
      conversationId: CONV, workspaceId: WS, actorUserId: "user-1", inviteeUserId: OTHER,
    })
  })

  it.each([
    [404, "CONVERSATION_NOT_FOUND"],
    [409, "CONVERSATION_NOT_SHAREABLE"],
    [422, "INVITEE_NOT_MEMBER"],
    [503, "PARTICIPANTS_UNAVAILABLE"],
  ])("maps a %i domain error to its status and code", async (status, code) => {
    mockAdd.mockRejectedValue(new AgentParticipantError("nope", status, code))
    const res = await post({ userId: OTHER })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: "nope", code })
  })

  it("hides unexpected failures behind a generic 500", async () => {
    mockAdd.mockRejectedValue(new Error("db password=hunter2"))
    const res = await post({ userId: OTHER })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("hunter2")
  })
})

describe("DELETE participant", () => {
  const del = (userId = OTHER, query = `workspaceId=${WS}`) =>
    DELETE(new Request(`http://test/x?${query}`, { method: "DELETE" }), ctx({ userId }))

  it("401s, 400s and 404s on malformed ids before touching the lib", async () => {
    mockAuth.mockResolvedValueOnce(null)
    expect((await del()).status).toBe(401)
    expect((await del(OTHER, "")).status).toBe(400)
    expect((await del("nope")).status).toBe(404)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it("returns the result when someone was removed or left", async () => {
    mockRemove.mockResolvedValue({ removed: true, left: true })
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true, left: true })
    expect(mockRemove.mock.calls[0][1]).toEqual({
      conversationId: CONV, workspaceId: WS, actorUserId: "user-1", targetUserId: OTHER,
    })
  })

  it("404s when the target was not an active participant", async () => {
    mockRemove.mockResolvedValue({ removed: false, left: false })
    expect((await del()).status).toBe(404)
  })

  it.each([
    [403, "REMOVE_FORBIDDEN"],
    [409, "OWNER_CANNOT_LEAVE"],
    [404, "CONVERSATION_NOT_FOUND"],
  ])("maps a %i domain error", async (status, code) => {
    mockRemove.mockRejectedValue(new AgentParticipantError("nope", status, code))
    const res = await del()
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })
})
