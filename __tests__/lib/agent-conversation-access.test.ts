import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  accessibleConversationsWhere,
  ownedConversationsWhere,
  resolveConversationAccess,
} from "@/lib/agent-conversation-access"

const findFirst = vi.fn()
const prisma = { agentConversation: { findFirst } } as never

beforeEach(() => vi.clearAllMocks())

const MEMBERSHIP = { workspace: { members: { some: { userId: "user-1" } } } }

describe("conversation access predicates", () => {
  it("owned predicate scopes to workspace, owner and live workspace membership", () => {
    expect(ownedConversationsWhere("ws-1", "user-1")).toEqual({
      workspaceId: "ws-1",
      userId: "user-1",
      ...MEMBERSHIP,
    })
  })

  it("accessible predicate is owner OR active non-interview participant, behind live workspace membership", () => {
    expect(accessibleConversationsWhere("ws-1", "user-1")).toEqual({
      workspaceId: "ws-1",
      ...MEMBERSHIP,
      OR: [
        { userId: "user-1" },
        {
          interviewProcessingJson: null,
          participants: { some: { userId: "user-1", workspaceId: "ws-1", removedAt: null } },
        },
      ],
    })
  })
})

describe("resolveConversationAccess", () => {
  it("returns the OWNER role when the caller owns the conversation", async () => {
    findFirst.mockResolvedValue({ userId: "user-1" })
    await expect(
      resolveConversationAccess(prisma, { conversationId: "c1", workspaceId: "ws-1", userId: "user-1" })
    ).resolves.toEqual({ role: "OWNER", ownerUserId: "user-1" })
  })

  it("returns the PARTICIPANT role when the conversation belongs to someone else", async () => {
    findFirst.mockResolvedValue({ userId: "owner-9" })
    await expect(
      resolveConversationAccess(prisma, { conversationId: "c1", workspaceId: "ws-1", userId: "user-1" })
    ).resolves.toEqual({ role: "PARTICIPANT", ownerUserId: "owner-9" })
  })

  it("returns null when no row matches, so callers answer 404 rather than 403", async () => {
    findFirst.mockResolvedValue(null)
    await expect(
      resolveConversationAccess(prisma, { conversationId: "c-x", workspaceId: "ws-1", userId: "user-1" })
    ).resolves.toBeNull()
  })

  it("queries by id with the accessible predicate, selecting only the owner id", async () => {
    findFirst.mockResolvedValue(null)
    await resolveConversationAccess(prisma, { conversationId: "c-x", workspaceId: "ws-1", userId: "user-1" })
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "c-x", ...accessibleConversationsWhere("ws-1", "user-1") },
      select: { userId: true },
    })
  })
})
