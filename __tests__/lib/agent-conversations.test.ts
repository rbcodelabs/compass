import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPrisma = {
  agentConversation: { findMany: vi.fn(), findFirst: vi.fn() },
  agentMessage: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { listAgentConversations, getAgentConversationMessages } from "@/lib/agent-conversations"

beforeEach(() => vi.clearAllMocks())

describe("listAgentConversations", () => {
  it("scopes to (workspaceId, userId), newest first", async () => {
    mockPrisma.agentConversation.findMany.mockResolvedValue([{ id: "c1", title: "Hi", updatedAt: new Date() }])
    const res = await listAgentConversations("ws-1", "user-1")
    expect(res).toHaveLength(1)
    expect(mockPrisma.agentConversation.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-1" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, updatedAt: true },
      take: 50,
    })
  })
})

describe("getAgentConversationMessages", () => {
  it("returns null for a conversation not owned by the user in the workspace (no leak)", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const res = await getAgentConversationMessages("c-x", "ws-1", "user-1")
    expect(res).toBeNull()
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith({
      where: { id: "c-x", workspaceId: "ws-1", userId: "user-1" },
      select: { id: true },
    })
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })

  it("returns messages oldest-first when owned", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([
      { id: "m1", role: "user", content: "hi", createdAt: new Date() },
      { id: "m2", role: "assistant", content: "hello", createdAt: new Date() },
    ])
    const res = await getAgentConversationMessages("c1", "ws-1", "user-1")
    expect(res).toHaveLength(2)
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: "c1" },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, createdAt: true },
    })
  })
})
