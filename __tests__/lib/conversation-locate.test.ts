/**
 * TASK-195 S3: locate the conversation that holds a message or a comment (the id in an old `?comment=<id>` link).
 * Unit level: which lookups happen, in which order, and that nothing is written for someone who may not read the thread.
 * The real-table behaviour (repair, access matrix, updatedAt) is in __tests__/conversation-locate.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock("@/lib/conversation-mirror", () => ({ ensureConversationForComment: mocks.ensure }))

import { locateConversationMessage } from "@/lib/conversation-locate"
import type { AppPrismaClient } from "@/lib/db"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MSG = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const USER = "user-1"

const readable = { id: CONV, targetType: "OPPORTUNITY", targetId: "opp-1", status: "RESOLVED", archivedAt: null as Date | null }

function fake() {
  return {
    agentMessage: { findUnique: vi.fn(), findFirst: vi.fn() },
    agentConversation: { findFirst: vi.fn(), findUnique: vi.fn() },
    comment: { findUnique: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
  }
}
let prisma: ReturnType<typeof fake>
const locate = (messageId = MSG) => locateConversationMessage(prisma as unknown as AppPrismaClient, { workspaceId: WS, userId: USER, messageId })

beforeEach(() => {
  vi.resetAllMocks()
  prisma = fake()
  prisma.agentMessage.findFirst.mockResolvedValue({ id: CONV })
})

describe("locateConversationMessage: message ids", () => {
  it("finds the conversation of an existing message with the shared read predicate, and writes nothing", async () => {
    prisma.agentMessage.findUnique.mockResolvedValue({ id: MSG, conversationId: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue(readable)
    expect(await locate()).toEqual({ conversationId: CONV, messageId: MSG, isRoot: false, targetType: "OPPORTUNITY", targetId: "opp-1", status: "RESOLVED", archived: false })
    expect(prisma.agentConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: CONV, workspaceId: WS, workspace: { members: { some: { userId: USER } } } }) }),
    )
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(prisma.comment.findUnique).not.toHaveBeenCalled()
  })

  it("reports the first message of a thread as the root", async () => {
    prisma.agentMessage.findUnique.mockResolvedValue({ id: CONV, conversationId: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue(readable)
    expect((await locate(CONV))?.isRoot).toBe(true)
  })

  it("reports an archived thread as located (archived threads stay readable) and says so", async () => {
    prisma.agentMessage.findUnique.mockResolvedValue({ id: MSG, conversationId: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue({ ...readable, archivedAt: new Date("2026-11-19T00:00:00Z") })
    expect(await locate()).toMatchObject({ conversationId: CONV, archived: true })
  })

  it("is null, and looks no further, when the caller may not read the message's conversation", async () => {
    prisma.agentMessage.findUnique.mockResolvedValue({ id: MSG, conversationId: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue(null)
    expect(await locate()).toBeNull()
    expect(prisma.comment.findUnique).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
})

describe("locateConversationMessage: comment ids (the mirror may be missing)", () => {
  beforeEach(() => prisma.agentMessage.findUnique.mockResolvedValue(null))

  it("is null for an id that is neither a message nor a comment", async () => {
    prisma.comment.findUnique.mockResolvedValue(null)
    expect(await locate()).toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it("is null for a comment in another workspace, without repairing anything", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: "other-ws", parentId: CONV })
    expect(await locate()).toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it("never repairs a mirror for someone who is not a member of the workspace", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: CONV })
    prisma.agentConversation.findUnique.mockResolvedValue(null)
    prisma.workspaceMember.findFirst.mockResolvedValue(null)
    expect(await locate()).toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it("repairs a missing conversation for a member (whole thread), then answers from the shared read predicate", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: CONV })
    prisma.agentConversation.findUnique.mockResolvedValue(null)
    prisma.workspaceMember.findFirst.mockResolvedValue({ userId: USER })
    mocks.ensure.mockResolvedValue({ conversationId: CONV, messageId: MSG })
    prisma.agentConversation.findFirst.mockResolvedValue(readable)
    expect(await locate()).toMatchObject({ conversationId: CONV, messageId: MSG })
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
    const options = (mocks.ensure.mock.calls[0]![2] ?? {}) as { scope?: string; fallbackUserId?: string }
    expect(options.scope).toBe("create-only")
    // The viewer must not become the owner of a conversation they did not start.
    expect(options.fallbackUserId).toBeUndefined()
  })

  it("is null when the repair finds the comment gone", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: CONV })
    prisma.agentConversation.findUnique.mockResolvedValue(null)
    prisma.workspaceMember.findFirst.mockResolvedValue({ userId: USER })
    mocks.ensure.mockResolvedValue(null)
    expect(await locate()).toBeNull()
  })

  it("repairs only the one message (comment scope, never lowering updatedAt) when the conversation exists and is readable", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: CONV })
    prisma.agentConversation.findUnique.mockResolvedValue({ id: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue(readable)
    mocks.ensure.mockResolvedValue({ conversationId: CONV, messageId: MSG })
    expect(await locate()).toMatchObject({ conversationId: CONV })
    expect(mocks.ensure).toHaveBeenCalledWith(prisma, MSG, expect.objectContaining({ scope: "comment" }))
  })

  it("writes nothing when the conversation exists but the caller cannot read it", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: CONV })
    prisma.agentConversation.findUnique.mockResolvedValue({ id: CONV })
    prisma.agentConversation.findFirst.mockResolvedValue(null)
    expect(await locate()).toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it("uses the comment's own id as the thread when it is a root", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS, parentId: null })
    prisma.agentConversation.findUnique.mockResolvedValue({ id: MSG })
    prisma.agentConversation.findFirst.mockResolvedValue({ ...readable, id: MSG })
    mocks.ensure.mockResolvedValue({ conversationId: MSG, messageId: MSG })
    expect(await locate()).toMatchObject({ conversationId: MSG, messageId: MSG, isRoot: true })
    expect(prisma.agentConversation.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: MSG } }))
  })
})
