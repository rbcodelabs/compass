/**
 * TASK-195 S2: archive and restore a shared conversation. There is NO hard delete anywhere in the new model.
 *
 * The mocked Prisma cannot evaluate a `where`, so the access boundary is asserted on the query the service sends (the
 * shared `accessibleConversationsWhere` predicate, with no `archivedAt` clause: an archived thread stays readable to
 * exactly the people who could read it before) and the denial paths are driven by what that query would return.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = {
  agentConversation: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  agentScheduledWakeup: { updateMany: vi.fn() },
  agentMessage: { findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  agentAuditLog: { create: vi.fn() },
  agentRun: { create: vi.fn() },
  comment: { delete: vi.fn(), deleteMany: vi.fn() },
  workspace: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { archiveCapabilities, canArchiveConversation, setConversationArchived } from "@/lib/conversation-archive"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const UPDATED = new Date("2026-11-01T10:00:00.000Z")
const SECRET_TEXT = "the quarterly plan is confidential"

const conversation = (over: Record<string, unknown> = {}) => ({
  userId: "owner",
  visibility: "WORKSPACE",
  interviewProcessingJson: null,
  archivedAt: null,
  updatedAt: UPDATED,
  targetType: "TASK",
  targetId: "task-1",
  ...over,
})
const noAdmin = { members: [{ role: "MEMBER" }], organization: { members: [{ role: "MEMBER" }] } }
const wsAdmin = { members: [{ role: "ADMIN" }], organization: { members: [{ role: "MEMBER" }] } }
const orgAdmin = { members: [{ role: "MEMBER" }], organization: { members: [{ role: "OWNER" }] } }

const run = (userId: string, archived = true) => setConversationArchived({ conversationId: CONV, workspaceId: WS, userId, archived })

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation())
  // The first message decides who started the thread; the content must never reach the audit row.
  mockPrisma.agentMessage.findFirst.mockResolvedValue({ authorUserId: "starter", content: SECRET_TEXT })
  mockPrisma.agentMessage.count.mockResolvedValue(3)
  mockPrisma.agentConversation.updateMany.mockResolvedValue({ count: 1 })
  // Re-read INSIDE the transaction; the stamp is compare-and-set on this value.
  mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: null, updatedAt: UPDATED })
  mockPrisma.agentScheduledWakeup.updateMany.mockResolvedValue({ count: 0 })
  mockPrisma.agentAuditLog.create.mockResolvedValue({})
  mockPrisma.workspace.findUnique.mockResolvedValue(noAdmin)
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
})

describe("canArchiveConversation (pure policy)", () => {
  it("allows the thread starter, a workspace admin or an org admin, nobody else", () => {
    expect(canArchiveConversation({ rootAuthorId: "a", userId: "a", isAdmin: false })).toBe(true)
    expect(canArchiveConversation({ rootAuthorId: "a", userId: "b", isAdmin: true })).toBe(true)
    expect(canArchiveConversation({ rootAuthorId: "a", userId: "b", isAdmin: false })).toBe(false)
  })
})

describe("setConversationArchived on a shared conversation: who may", () => {
  it("lets the thread starter archive it", async () => {
    expect(await run("starter")).toEqual({ ok: true, archived: true, changed: true })
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled()
  })

  it("treats the conversation owner as the starter when the first message predates author tracking", async () => {
    mockPrisma.agentMessage.findFirst.mockResolvedValue({ authorUserId: null })
    expect(await run("owner")).toMatchObject({ ok: true })
  })

  it("refuses another member with 403 and touches nothing", async () => {
    expect(await run("other-member")).toEqual({ ok: false, status: 403 })
    expect(mockPrisma.agentConversation.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentAuditLog.create).not.toHaveBeenCalled()
  })

  it("lets a workspace admin archive someone else's thread", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(wsAdmin)
    expect(await run("admin")).toMatchObject({ ok: true, changed: true })
  })

  it("lets an org admin archive someone else's thread", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(orgAdmin)
    expect(await run("org-admin")).toMatchObject({ ok: true, changed: true })
  })

  it("answers 404, never 403, to someone who cannot see the conversation (non-member)", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    expect(await run("stranger")).toEqual({ ok: false, status: 404 })
    expect(mockPrisma.agentConversation.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentAuditLog.create).not.toHaveBeenCalled()
  })

  it("reads the conversation through the shared access predicate with no archivedAt clause", async () => {
    await run("starter")
    const where = mockPrisma.agentConversation.findFirst.mock.calls[0]![0].where
    expect(where).toEqual({ id: CONV, ...accessibleConversationsWhere(WS, "starter") })
    expect(JSON.stringify(where)).not.toContain("archivedAt")
  })
})

describe("setConversationArchived: effect", () => {
  it("archives by stamping archivedAt only when it is still null, and never touches a message, a run or a comment", async () => {
    await run("starter")
    expect(mockPrisma.agentConversation.updateMany).toHaveBeenCalledWith({
      // Compare-and-set on updatedAt: a message that lands between the read and the write is never reverted.
      where: { id: CONV, workspaceId: WS, updatedAt: UPDATED, archivedAt: null },
      // Prisma's updatedAt extension stamps `now` on any update that omits it; archiving must not reorder the list.
      data: { archivedAt: expect.any(Date), updatedAt: UPDATED },
    })
    expect(mockPrisma.agentMessage.update).not.toHaveBeenCalled()
    expect(mockPrisma.agentMessage.delete).not.toHaveBeenCalled()
    expect(mockPrisma.agentMessage.deleteMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentConversation.delete).not.toHaveBeenCalled()
    expect(mockPrisma.agentConversation.deleteMany).not.toHaveBeenCalled()
    expect(mockPrisma.comment.delete).not.toHaveBeenCalled()
    expect(mockPrisma.comment.deleteMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentRun.create).not.toHaveBeenCalled()
  })

  it("restores by clearing archivedAt only on an archived row", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ archivedAt: new Date() }))
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: new Date(), updatedAt: UPDATED })
    expect(await run("starter", false)).toEqual({ ok: true, archived: false, changed: true })
    expect(mockPrisma.agentConversation.updateMany).toHaveBeenCalledWith({
      where: { id: CONV, workspaceId: WS, updatedAt: UPDATED, archivedAt: { not: null } },
      data: { archivedAt: null, updatedAt: UPDATED },
    })
  })

  it("is idempotent: archiving an archived thread succeeds, changes nothing and writes no second audit row", async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: new Date(), updatedAt: UPDATED })
    expect(await run("starter")).toEqual({ ok: true, archived: true, changed: false })
    expect(mockPrisma.agentConversation.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.agentAuditLog.create).not.toHaveBeenCalled()
    expect(mockPrisma.agentScheduledWakeup.updateMany).not.toHaveBeenCalled()
  })

  it("is idempotent for restore of a thread that is not archived", async () => {
    expect(await run("starter", false)).toEqual({ ok: true, archived: false, changed: false })
    expect(mockPrisma.agentAuditLog.create).not.toHaveBeenCalled()
  })
})

describe("setConversationArchived: audit row", () => {
  it("records ids, role and counts, and never message text", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(wsAdmin)
    await run("admin")
    expect(mockPrisma.agentAuditLog.create).toHaveBeenCalledTimes(1)
    const { data } = mockPrisma.agentAuditLog.create.mock.calls[0]![0]
    expect(data).toMatchObject({ userId: "admin", workspaceId: WS, toolName: "conversation.archive", conversationId: null })
    expect(JSON.parse(data.argsSummary)).toEqual({
      conversationId: CONV, targetType: "TASK", targetId: "task-1", messageCount: 3, actedBy: "admin", role: "ADMIN",
    })
    expect(JSON.stringify(data)).not.toContain(SECRET_TEXT)
  })

  it("labels a restore and the starter role", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ archivedAt: new Date() }))
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: new Date(), updatedAt: UPDATED })
    await run("starter", false)
    const { data } = mockPrisma.agentAuditLog.create.mock.calls[0]![0]
    expect(data.toolName).toBe("conversation.restore")
    expect(JSON.parse(data.argsSummary).role).toBe("STARTER")
  })

  it("writes the row in the same transaction as the state change", async () => {
    await run("starter")
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe("setConversationArchived on a private chat", () => {
  it("keeps the owner-only rule: the owner may, anyone else gets 404", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ visibility: "PRIVATE" }))
    expect(await run("owner")).toMatchObject({ ok: true, changed: true })
    expect(mockPrisma.agentConversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { archivedAt: expect.any(Date), updatedAt: UPDATED } }))
    expect(await run("participant")).toEqual({ ok: false, status: 404 })
    expect(mockPrisma.agentAuditLog.create).not.toHaveBeenCalled()
  })

  it("is idempotent too: archiving an archived private chat reports changed false", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ visibility: "PRIVATE" }))
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: new Date(), updatedAt: UPDATED })
    expect(await run("owner")).toEqual({ ok: true, archived: true, changed: false })
  })
})

describe("setConversationArchived: concurrency, wakeups, read-only", () => {
  it("re-reads updatedAt and retries when a message bumped it between the read and the write", async () => {
    const BUMPED = new Date("2026-11-02T10:00:00.000Z")
    mockPrisma.agentConversation.findUnique
      .mockResolvedValueOnce({ archivedAt: null, updatedAt: UPDATED })
      .mockResolvedValueOnce({ archivedAt: null, updatedAt: BUMPED })
    mockPrisma.agentConversation.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })
    expect(await run("starter")).toMatchObject({ ok: true, changed: true })
    expect(mockPrisma.agentConversation.updateMany).toHaveBeenLastCalledWith({
      where: { id: CONV, workspaceId: WS, updatedAt: BUMPED, archivedAt: null },
      data: { archivedAt: expect.any(Date), updatedAt: BUMPED },
    })
  })

  it("cancels every pending scheduled wake-up when archiving, in the same transaction, and not when restoring", async () => {
    await run("starter")
    expect(mockPrisma.agentScheduledWakeup.updateMany).toHaveBeenCalledWith({
      where: { conversationId: CONV, status: "PENDING" },
      data: expect.objectContaining({ status: "CANCELED" }),
    })
    vi.clearAllMocks()
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ archivedAt: new Date() }))
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ archivedAt: new Date(), updatedAt: UPDATED })
    mockPrisma.agentConversation.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.agentMessage.findFirst.mockResolvedValue({ authorUserId: "starter" })
    mockPrisma.agentMessage.count.mockResolvedValue(1)
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
    await run("starter", false)
    expect(mockPrisma.agentScheduledWakeup.updateMany).not.toHaveBeenCalled()
  })
})

describe("archiveCapabilities", () => {
  it("offers archive on a live shared thread and restore on an archived one, never both", async () => {
    expect(await archiveCapabilities({ conversationId: CONV, workspaceId: WS, userId: "starter" })).toEqual({ archived: false, canArchive: true, canRestore: false })
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ archivedAt: new Date() }))
    expect(await archiveCapabilities({ conversationId: CONV, workspaceId: WS, userId: "starter" })).toEqual({ archived: true, canArchive: false, canRestore: true })
  })
  it("grants nothing to a member without the right, and nothing for a private chat", async () => {
    expect(await archiveCapabilities({ conversationId: CONV, workspaceId: WS, userId: "other-member" })).toMatchObject({ canArchive: false, canRestore: false })
    mockPrisma.agentConversation.findFirst.mockResolvedValue(conversation({ visibility: "PRIVATE", archivedAt: new Date() }))
    expect(await archiveCapabilities({ conversationId: CONV, workspaceId: WS, userId: "owner" })).toEqual({ archived: true, canArchive: false, canRestore: false })
  })
})
