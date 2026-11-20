/** TASK-195 S2: an archived shared conversation is closed to new turns, which the sender sees as "no longer available". */
import { describe, expect, it, vi } from "vitest"
import { isClosedToNewTurns, resolveConversationAccess } from "@/lib/agent-conversation-access"

describe("isClosedToNewTurns", () => {
  it("closes an archived WORKSPACE conversation", () => {
    expect(isClosedToNewTurns({ visibility: "WORKSPACE", archived: true })).toBe(true)
  })
  it("leaves an unarchived shared one, and a private chat the owner archived, open (existing behaviour)", () => {
    expect(isClosedToNewTurns({ visibility: "WORKSPACE", archived: false })).toBe(false)
    expect(isClosedToNewTurns({ visibility: "PRIVATE", archived: true })).toBe(false)
  })
})

describe("resolveConversationAccess", () => {
  it("reports archived state and visibility without changing who may access", async () => {
    const findFirst = vi.fn(async () => ({ userId: "owner", visibility: "WORKSPACE", archivedAt: new Date() }))
    const access = await resolveConversationAccess({ agentConversation: { findFirst } } as never, { conversationId: "c", workspaceId: "w", userId: "u" })
    expect(access).toEqual({ role: "PARTICIPANT", ownerUserId: "owner", visibility: "WORKSPACE", archived: true })
  })
})
