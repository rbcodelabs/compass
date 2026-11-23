import { describe, expect, it, vi } from "vitest"
import {
  backfillUnifiedConversations,
  deriveConversationTitleFromComment,
} from "@/lib/unified-conversations-backfill"

describe("backfillUnifiedConversations", () => {
  it("derives a concise title from markdown comment bodies", () => {
    expect(deriveConversationTitleFromComment("## Scope Check\nLet's verify DSQL limits")).toBe("Scope Check")
    expect(deriveConversationTitleFromComment("   \n- First bullet point")).toBe("First bullet point")
  })

  it("promotes root comments to AgentConversation with identical UUID and replies to chronological AgentMessage rows", async () => {
    const t0 = new Date("2026-11-16T12:00:00.000Z")
    const t1 = new Date("2026-11-16T12:05:00.000Z")
    const rootId = "11111111-1111-4111-8111-111111111111"
    const replyId = "22222222-2222-4222-8222-222222222222"
    const targetId = "33333333-3333-4333-8333-333333333333"

    const conversationUpsert = vi.fn().mockResolvedValue({ id: rootId })
    const messageUpsert = vi.fn().mockResolvedValue({ id: rootId })

    const prisma = {
      comment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: rootId,
            workspaceId: "ws-1",
            targetType: "OPPORTUNITY",
            targetId,
            parentId: null,
            authorId: "user-1",
            authorName: "Rick Bowman",
            authorType: "HUMAN",
            source: "BROWSER",
            body: "Should we unify Comments and Agent Conversations?",
            status: "OPEN",
            createdAt: t0,
            updatedAt: t0,
          },
          {
            id: replyId,
            workspaceId: "ws-1",
            targetType: "OPPORTUNITY",
            targetId,
            parentId: rootId,
            authorId: null,
            authorName: "Compass Agent",
            authorType: "AGENT",
            source: "MCP",
            body: "Yes — extending AgentConversation preserves all sidecar UUID anchors.",
            status: "OPEN",
            createdAt: t1,
            updatedAt: t1,
          },
        ]),
      },
      agentConversation: {
        upsert: conversationUpsert,
      },
      agentMessage: {
        // The mirror reads which of these messages already exist (to leave editedAt alone when the text is unchanged).
        findMany: vi.fn().mockResolvedValue([]),
        upsert: messageUpsert,
      },
    } as never

    const res = await backfillUnifiedConversations(prisma, { workspaceId: "ws-1", fallbackUserId: "user-1" })
    expect(res.conversationsPromoted).toBe(1)
    expect(res.messagesPromoted).toBe(2)

    expect(conversationUpsert).toHaveBeenCalledTimes(1)
    expect(conversationUpsert.mock.calls[0]?.[0]).toMatchObject({
      where: { id: rootId },
      create: {
        id: rootId,
        workspaceId: "ws-1",
        userId: "user-1",
        targetType: "OPPORTUNITY",
        targetId,
        visibility: "WORKSPACE",
        status: "OPEN",
        agentMode: "MENTION_ONLY",
      },
    })

    expect(messageUpsert).toHaveBeenCalledTimes(2)
    expect(messageUpsert.mock.calls[0]?.[0]?.create).toMatchObject({
      id: rootId,
      conversationId: rootId,
      role: "user",
      authorName: "Rick Bowman",
      authorType: "HUMAN",
      messageKind: "COMMENT",
    })
    expect(messageUpsert.mock.calls[1]?.[0]?.create).toMatchObject({
      id: replyId,
      conversationId: rootId,
      role: "assistant",
      authorName: "Compass Agent",
      authorType: "AGENT",
    })
  })
})
