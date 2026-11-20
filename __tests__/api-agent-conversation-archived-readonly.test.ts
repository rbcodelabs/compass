/** TASK-195 S2: writes to an archived shared conversation answer 409 (the caller can see it, so 404 would mislead). */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), findFirst: vi.fn(), addParticipant: vi.fn(), findUnique: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ agentConversation: { findFirst: mocks.findFirst, findUnique: mocks.findUnique, updateMany: vi.fn(), update: vi.fn() } }) }))
vi.mock("@/lib/agent-conversation-participants", async (orig) => ({ ...(await orig<object>()), addConversationParticipant: mocks.addParticipant }))

import { POST } from "@/app/api/agent/conversations/[conversationId]/participants/route"
import { PATCH } from "@/app/api/agent/conversations/[conversationId]/settings/route"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const ctx = { params: Promise.resolve({ conversationId: CONV }) }
const archived = { userId: "owner", visibility: "WORKSPACE", archivedAt: new Date() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "u" } })
  mocks.findFirst.mockResolvedValue(archived)
})

describe("archived shared conversation is read-only", () => {
  it("refuses an invite", async () => {
    const res = await POST(new Request(`http://localhost/x?workspaceId=${WS}`, { method: "POST", body: JSON.stringify({ userId: WS }) }), ctx)
    expect(res.status).toBe(409)
    expect(mocks.addParticipant).not.toHaveBeenCalled()
  })
  it("refuses a settings change (resolve, mode, visibility)", async () => {
    const res = await PATCH(new NextRequest(`http://localhost/x?workspaceId=${WS}`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) }), ctx)
    expect(res.status).toBe(409)
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })
})
