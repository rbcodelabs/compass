/**
 * TASK-195 S1: editing a message in a shared conversation.
 *
 * The mocked Prisma cannot evaluate a `where`, so the access boundary is asserted on the query the service sends
 * (the shared `accessibleConversationsWhere` predicate) and the denial paths are driven by what it would return.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = {
  agentConversation: { findFirst: vi.fn(), update: vi.fn() },
  agentMessage: { findFirst: vi.fn(), update: vi.fn() },
  comment: { findUnique: vi.fn(), update: vi.fn() },
  workspace: { findUnique: vi.fn() },
  agentRun: { create: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { canEditMessage, editConversationMessage, MESSAGE_CONTENT_MAX } from "@/lib/conversation-messages"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MSG = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const CONV_UPDATED = new Date("2026-11-01T10:00:00.000Z")

const conversation = (over: Record<string, unknown> = {}) => ({
  userId: "owner",
  visibility: "WORKSPACE",
  interviewProcessingJson: null,
  title: "Original words",
  summary: "Original words",
  updatedAt: CONV_UPDATED,
  ...over,
})
const message = (over: Record<string, unknown> = {}) => ({
  id: MSG,
  role: "user",
  content: "Original words",
  authorUserId: "author",
  authorType: "HUMAN",
  messageKind: "COMMENT",
  ...over,
})
const noAdmin = { members: [{ role: "MEMBER" }], organization: { members: [{ role: "MEMBER" }] } }
const wsAdmin = { members: [{ role: "ADMIN" }], organization: { members: [{ role: "MEMBER" }] } }
const orgAdmin = { members: [{ role: "MEMBER" }], organization: { members: [{ role: "OWNER" }] } }

function edit(userId: string, content = "New **words**") {
  return editConversationMessage({ conversationId: CONV, messageId: MSG, workspaceId: WS, userId, content })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation())
  mockPrisma.agentMessage.findFirst.mockImplementation(async (args: { orderBy?: { createdAt: string } }) =>
    args?.orderBy ? { id: MSG } : message(),
  )
  mockPrisma.agentMessage.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...message(), ...data }))
  mockPrisma.agentConversation.update.mockResolvedValue({})
  mockPrisma.comment.findUnique.mockResolvedValue(null)
  mockPrisma.comment.update.mockResolvedValue({})
  mockPrisma.workspace.findUnique.mockResolvedValue(noAdmin)
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
})

describe("canEditMessage", () => {
  const ctx = (over = {}) => ({ ownerUserId: "owner", visibility: "WORKSPACE", isInterview: false, userId: "author", isAdmin: false, ...over })
  it("allows the author, and a workspace admin on someone else's message", () => {
    expect(canEditMessage(message(), ctx())).toBe(true)
    expect(canEditMessage(message(), ctx({ userId: "boss", isAdmin: true }))).toBe(true)
    expect(canEditMessage(message(), ctx({ userId: "other" }))).toBe(false)
  })
  it("treats a message with no recorded author as the conversation owner's", () => {
    expect(canEditMessage(message({ authorUserId: null }), ctx({ userId: "owner" }))).toBe(true)
    expect(canEditMessage(message({ authorUserId: null }), ctx({ userId: "author" }))).toBe(false)
  })
  it.each([
    ["assistant role", { role: "assistant" }],
    ["agent author", { authorType: "AGENT" }],
    ["external author", { authorType: "EXTERNAL" }],
    ["plan proposal", { messageKind: "PLAN_PROPOSAL" }],
    ["system resolution", { messageKind: "SYSTEM_RESOLUTION" }],
    ["approval update", { content: "[Approval update] something" }],
  ])("never allows a %s message, even for an admin author", (_name, over) => {
    expect(canEditMessage(message(over), ctx({ isAdmin: true }))).toBe(false)
  })
  it("accepts null and MESSAGE kinds and a null author type (older rows)", () => {
    expect(canEditMessage(message({ messageKind: null, authorType: null }), ctx())).toBe(true)
    expect(canEditMessage(message({ messageKind: "MESSAGE" }), ctx())).toBe(true)
  })
  it("is off in private chats and interview conversations", () => {
    expect(canEditMessage(message(), ctx({ visibility: "PRIVATE" }))).toBe(false)
    expect(canEditMessage(message(), ctx({ visibility: null }))).toBe(false)
    expect(canEditMessage(message(), ctx({ isInterview: true }))).toBe(false)
  })
})

describe("editConversationMessage authorization matrix", () => {
  it("lets the author edit and returns the edited message with an editedAt", async () => {
    const result = await edit("author")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.message).toMatchObject({ id: MSG, content: "New **words**", canEdit: true })
    expect(result.message.editedAt).toBeInstanceOf(Date)
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled()
  })

  it("lets a workspace admin edit another member's message", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(wsAdmin)
    const result = await edit("boss")
    expect(result.ok).toBe(true)
    expect(mockPrisma.agentMessage.update).toHaveBeenCalled()
  })

  it("lets an organization admin edit another member's message", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(orgAdmin)
    expect((await edit("boss")).ok).toBe(true)
  })

  it("403s another member who can see the conversation, and writes nothing", async () => {
    const result = await edit("other")
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.agentMessage.update).not.toHaveBeenCalled()
  })

  it("404s a non-member or an invisible conversation (never 403), and reads no message", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const result = await edit("stranger")
    expect(result).toMatchObject({ ok: false, status: 404 })
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: CONV, ...accessibleConversationsWhere(WS, "stranger") }) }),
    )
    expect(mockPrisma.agentMessage.findFirst).not.toHaveBeenCalled()
  })

  it("404s a message that is not in this conversation", async () => {
    mockPrisma.agentMessage.findFirst.mockResolvedValue(null)
    expect(await edit("author")).toMatchObject({ ok: false, status: 404 })
    expect(mockPrisma.agentMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MSG, conversationId: CONV } }),
    )
  })

  it("403s an assistant message even for an admin", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(wsAdmin)
    mockPrisma.agentMessage.findFirst.mockResolvedValue(message({ role: "assistant", authorUserId: null }))
    expect(await edit("boss")).toMatchObject({ ok: false, status: 403 })
  })

  it("400s empty and over-long content without touching the database", async () => {
    expect(await edit("author", "   ")).toMatchObject({ ok: false, status: 400 })
    expect(await edit("author", "x".repeat(MESSAGE_CONTENT_MAX + 1))).toMatchObject({ ok: false, status: 400 })
    expect(mockPrisma.agentConversation.findFirst).not.toHaveBeenCalled()
  })

  it("does not echo message content or entity words in an error", async () => {
    const result = await edit("other", "secret plans")
    expect(JSON.stringify(result)).not.toMatch(/secret|Original words/)
  })
})

describe("editConversationMessage writes", () => {
  it("updates the message only when there is no mirrored comment row", async () => {
    await edit("author")
    expect(mockPrisma.agentMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MSG }, data: expect.objectContaining({ content: "New **words**", editedAt: expect.any(Date) }) }),
    )
    expect(mockPrisma.comment.update).not.toHaveBeenCalled()
  })

  it("updates the message AND the mirrored comment row, in one transaction, with the same instant", async () => {
    mockPrisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: WS })
    await edit("author")
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    const msgData = mockPrisma.agentMessage.update.mock.calls[0]![0].data
    const commentCall = mockPrisma.comment.update.mock.calls[0]![0]
    expect(commentCall.where).toEqual({ id: MSG })
    expect(commentCall.data).toEqual({ body: "New **words**", updatedAt: msgData.editedAt })
  })

  it("ignores a comment row that belongs to another workspace", async () => {
    mockPrisma.comment.findUnique.mockResolvedValue({ id: MSG, workspaceId: "someone-else" })
    await edit("author")
    expect(mockPrisma.comment.update).not.toHaveBeenCalled()
  })

  it("does not reorder the conversation: updatedAt is never bumped", async () => {
    await edit("author")
    for (const [arg] of mockPrisma.agentConversation.update.mock.calls) {
      expect(arg.data.updatedAt).toEqual(CONV_UPDATED)
    }
  })

  it("re-derives the title only when it still equals the one derived from the old text", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ title: "Original words" }))
    await edit("author", "Brand new opening line\nmore")
    expect(mockPrisma.agentConversation.update.mock.calls[0]![0].data).toMatchObject({ title: "Brand new opening line" })

    mockPrisma.agentConversation.update.mockClear()
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ title: "Renamed by a person" }))
    await edit("author", "Brand new opening line")
    const data = mockPrisma.agentConversation.update.mock.calls[0]?.[0].data ?? {}
    expect(data).not.toHaveProperty("title")
  })

  it("never starts or re-runs an agent, even when the message was already answered", async () => {
    await edit("author")
    expect(mockPrisma.agentRun.create).not.toHaveBeenCalled()
  })
})
