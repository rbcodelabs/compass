import { beforeEach, describe, expect, it, vi } from "vitest"

const links = vi.hoisted(() => ({ recordConversationLink: vi.fn(), deleteLinksForEntity: vi.fn() }))
vi.mock("@/lib/links/conversation-links", () => ({
  isConversationLinkTarget: (type: string) => type === "OPPORTUNITY",
  recordConversationLink: links.recordConversationLink,
}))
vi.mock("@/lib/links/service", () => ({ deleteLinksForEntity: links.deleteLinksForEntity }))
const dbHolder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => dbHolder.current }))

import {
  ARCHIVED_MIRROR_TITLE,
  COMMENT_MIRROR_MESSAGE_KIND,
  commentMirrorMessageKind,
  ensureConversationForComment,
  mirrorCommentAfterCommit,
  removeCommentMirror,
  removeCommentMirrorAfterCommit,
} from "@/lib/conversation-mirror"

const WS = "ws-1"
const ROOT = "11111111-1111-4111-8111-111111111111"
const REPLY = "22222222-2222-4222-8222-222222222222"
const TARGET = "33333333-3333-4333-8333-333333333333"
const t0 = new Date("2026-11-16T12:00:00.000Z")
const t1 = new Date("2026-11-16T12:05:00.000Z")
const t2 = new Date("2026-11-16T12:30:00.000Z")
const SECRET_ROOT = "Root text that must not survive"
const SECRET_REPLY = "Reply text that must not survive"

type Row = Record<string, unknown>
type Extra = {
  /** Non-zero counts for the "other content" delegates, keyed by delegate name. */
  counts?: Record<string, number>
  panelMessages?: Row[]
  interview?: string | null
  /** conversationId filter value other participants appear under. */
  onUpsert?: () => void
}

/** In-memory stand-in for the delegates the mirror touches. Filters on conversationId / id lists are honoured. */
function fakeDb(comments: Row[], extra: Extra = {}) {
  const conversations = new Map<string, Row>()
  const messages = new Map<string, Row>()
  for (const message of extra.panelMessages ?? []) messages.set(message.id as string, message)
  const counts = extra.counts ?? {}
  const countOf = (name: string) => vi.fn(async () => counts[name] ?? 0)
  const inIds = (where: { id?: { in?: string[]; notIn?: string[] }; conversationId?: string }, m: Row) =>
    (where.conversationId === undefined || m.conversationId === where.conversationId) &&
    (where.id?.in === undefined || where.id.in.includes(m.id as string))
  const db = {
    comment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => comments.find((c) => c.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { parentId?: string } }) => comments.filter((c) => (where.parentId ? c.parentId === where.parentId : true))),
    },
    workspaceMember: { findFirst: vi.fn(async () => ({ userId: "member-1" })) },
    agentConversation: {
      upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
        const existing = conversations.get(where.id)
        conversations.set(where.id, existing ? { ...existing, ...update } : { ...create })
        return conversations.get(where.id)
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = conversations.get(where.id)
        return found ? { ...found, interviewProcessingJson: extra.interview ?? null } : null
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; resolvedAt?: null }; data: Row }) => {
        const found = conversations.get(where.id)
        if (!found) return { count: 0 }
        if (where.resolvedAt === null && found.resolvedAt != null) return { count: 0 }
        conversations.set(where.id, { ...found, ...data })
        return { count: 1 }
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({ count: conversations.delete(where.id) ? 1 : 0 })),
    },
    agentMessage: {
      upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
        extra.onUpsert?.()
        const existing = messages.get(where.id)
        messages.set(where.id, existing ? { ...existing, ...update } : { ...create })
        return messages.get(where.id)
      }),
      count: vi.fn(async ({ where }: { where: { conversationId: string } }) => [...messages.values()].filter((m) => m.conversationId === where.conversationId).length),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; conversationId?: string } }) => [...messages.values()].filter((m) => inIds(where, m))),
      findFirst: vi.fn(async ({ where }: { where: { conversationId: string } }) =>
        [...messages.values()].filter((m) => m.conversationId === where.conversationId).sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())[0] ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; conversationId?: string } }) => {
        let count = 0
        for (const [id, m] of [...messages]) if (inIds(where, m) && messages.delete(id)) count++
        return { count }
      }),
    },
    agentRun: { count: countOf("agentRun") },
    agentChildRun: { count: countOf("agentChildRun") },
    agentInboxItem: { count: countOf("agentInboxItem") },
    agentScheduledWakeup: { count: countOf("agentScheduledWakeup") },
    agentConversationParticipant: { count: countOf("participant"), deleteMany: vi.fn(async () => ({ count: 0 })) },
    agentConversationReview: { count: countOf("agentConversationReview") },
    agentAuditLog: { count: countOf("agentAuditLog") },
    agentSession: { count: countOf("agentSession") },
    agentWebSearch: { count: countOf("agentWebSearch") },
    agentWebFetch: { count: countOf("agentWebFetch") },
    pMInterview: { count: countOf("pMInterview") },
    apiKey: { count: countOf("apiKey") },
    entityLink: { count: countOf("entityLink") },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  }
  return { db, conversations, messages }
}

const root = (over: Row = {}): Row => ({
  id: ROOT, workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: null, authorId: "user-1",
  authorName: "Rick", authorType: "HUMAN", source: "UI", body: SECRET_ROOT, status: "OPEN",
  createdAt: t0, updatedAt: t0, solutionPlanProposal: null, ...over,
})
const reply = (over: Row = {}): Row => ({
  id: REPLY, workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: ROOT, authorId: "user-2",
  authorName: "Dana", authorType: "HUMAN", source: "UI", body: SECRET_REPLY, status: "OPEN",
  createdAt: t1, updatedAt: t1, solutionPlanProposal: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  links.recordConversationLink.mockResolvedValue("created")
  links.deleteLinksForEntity.mockResolvedValue(0)
})

describe("messageKind is unified", () => {
  it("uses one value for every comment-origin message and PLAN_PROPOSAL for plan rows", () => {
    expect(COMMENT_MIRROR_MESSAGE_KIND).toBe("COMMENT")
    expect(commentMirrorMessageKind(false)).toBe("COMMENT")
    expect(commentMirrorMessageKind(true)).toBe("PLAN_PROPOSAL")
  })

  it("writes the same kind from the repair path that the backfill writes", async () => {
    const { db, messages } = fakeDb([root(), reply()])
    await ensureConversationForComment(db as never, REPLY)
    expect(messages.get(ROOT)?.messageKind).toBe("COMMENT")
    expect(messages.get(REPLY)?.messageKind).toBe("COMMENT")
  })

  it("keeps a Solution plan proposal as PLAN_PROPOSAL", async () => {
    const { db, messages } = fakeDb([root({ solutionPlanProposal: { commentId: ROOT } })])
    await ensureConversationForComment(db as never, ROOT)
    expect(messages.get(ROOT)?.messageKind).toBe("PLAN_PROPOSAL")
  })
})

describe("ensureConversationForComment", () => {
  it("creates the conversation and every thread message with the comment ids", async () => {
    const { db, conversations, messages } = fakeDb([root(), reply()])
    const result = await ensureConversationForComment(db as never, REPLY)
    expect(result).toEqual({ conversationId: ROOT, messageId: REPLY })
    expect(conversations.get(ROOT)).toMatchObject({ id: ROOT, userId: "user-1", visibility: "WORKSPACE", agentMode: "MENTION_ONLY", targetType: "OPPORTUNITY", targetId: TARGET })
    expect([...messages.keys()].sort()).toEqual([ROOT, REPLY].sort())
  })

  it("is idempotent: a second call returns the same ids and creates no extra rows", async () => {
    const { db, conversations, messages } = fakeDb([root(), reply()])
    const first = await ensureConversationForComment(db as never, ROOT)
    const second = await ensureConversationForComment(db as never, ROOT)
    expect(second).toEqual(first)
    expect(conversations.size).toBe(1)
    expect(messages.size).toBe(2)
  })

  it("repairs a missing mirror for a reply whose root has no conversation", async () => {
    const { db, conversations } = fakeDb([root(), reply()])
    await ensureConversationForComment(db as never, REPLY)
    expect(conversations.has(ROOT)).toBe(true)
  })

  it("returns null for an unknown comment, an orphan reply, and an ownerless thread", async () => {
    const { db } = fakeDb([reply()])
    await expect(ensureConversationForComment(db as never, "missing")).resolves.toBeNull()
    await expect(ensureConversationForComment(db as never, REPLY)).resolves.toBeNull()
    const ownerless = fakeDb([root({ authorId: null })])
    ownerless.db.workspaceMember.findFirst.mockResolvedValue(null as never)
    await expect(ensureConversationForComment(ownerless.db as never, ROOT)).resolves.toBeNull()
  })

  it("undoes its own writes when the comment is deleted while it was writing (create-vs-delete race)", async () => {
    const comments = [root(), reply()]
    const { db, conversations, messages } = fakeDb(comments, { onUpsert: () => { comments.length = 0 } })
    await expect(ensureConversationForComment(db as never, ROOT)).resolves.toBeNull()
    expect(conversations.size).toBe(0)
    expect(messages.size).toBe(0)
  })

  it("removes only the reply message when just the reply vanished mid-write", async () => {
    const comments = [root(), reply()]
    const { db, conversations, messages } = fakeDb(comments, { onUpsert: () => { if (comments.length === 2) comments.pop() } })
    await expect(ensureConversationForComment(db as never, REPLY)).resolves.toBeNull()
    expect(conversations.has(ROOT)).toBe(true)
    expect(messages.has(REPLY)).toBe(false)
  })

  it("reopening a resolved thread clears resolvedAt and resolvedById; resolving keeps an existing resolve time", async () => {
    const comments = [root({ status: "RESOLVED", updatedAt: t1 })]
    const { db, conversations } = fakeDb(comments)
    await ensureConversationForComment(db as never, ROOT)
    expect(conversations.get(ROOT)).toMatchObject({ status: "RESOLVED", resolvedAt: t1 })
    conversations.set(ROOT, { ...conversations.get(ROOT), resolvedAt: t2, resolvedById: "user-9" })
    await ensureConversationForComment(db as never, ROOT)
    expect(conversations.get(ROOT)?.resolvedAt).toEqual(t2)
    comments[0] = root({ status: "OPEN", updatedAt: t2 })
    await ensureConversationForComment(db as never, ROOT)
    expect(conversations.get(ROOT)).toMatchObject({ status: "OPEN", resolvedAt: null, resolvedById: null })
  })
})

describe("mirrorCommentAfterCommit (create path)", () => {
  it("writes only the new comment's message and never lowers updatedAt or overwrites a newer summary", async () => {
    const { db, conversations, messages } = fakeDb([root(), reply()])
    await ensureConversationForComment(db as never, ROOT)
    // A panel message / agent answer lands later and updates the conversation header.
    conversations.set(ROOT, { ...conversations.get(ROOT), updatedAt: t2, summary: "Newer agent answer" })
    db.agentMessage.upsert.mockClear()
    dbHolder.current = db
    await mirrorCommentAfterCommit(REPLY)
    expect(db.agentMessage.upsert).toHaveBeenCalledTimes(1)
    expect(messages.has(REPLY)).toBe(true)
    expect(conversations.get(ROOT)).toMatchObject({ updatedAt: t2, summary: "Newer agent answer" })
  })

  it("moves the summary and updatedAt forward when the new comment is the newest activity", async () => {
    const comments = [root()]
    const { db, conversations } = fakeDb(comments)
    await ensureConversationForComment(db as never, ROOT)
    expect(conversations.get(ROOT)).toMatchObject({ updatedAt: t0, summary: SECRET_ROOT })
    comments.push(reply())
    dbHolder.current = db
    await mirrorCommentAfterCommit(REPLY)
    expect(conversations.get(ROOT)).toMatchObject({ updatedAt: t1, summary: SECRET_REPLY })
  })

  it("never throws when the mirror write fails, and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    dbHolder.current = { comment: { findUnique: vi.fn().mockRejectedValue(new Error("mirror down")) } }
    await expect(mirrorCommentAfterCommit(ROOT)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conversation-mirror"), expect.any(Error))
    error.mockRestore()
  })
})

describe("removeCommentMirror", () => {
  async function seeded(extra: Extra = {}) {
    const fake = fakeDb([root(), reply()], extra)
    await ensureConversationForComment(fake.db as never, ROOT)
    return fake
  }
  const deleteThread = (db: unknown) => removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [ROOT, REPLY], threadDeleted: true })

  it("removes the reply message and refreshes summary and updatedAt so the deleted text is not left behind", async () => {
    const { db, conversations, messages } = await seeded()
    expect(conversations.get(ROOT)).toMatchObject({ summary: SECRET_REPLY, updatedAt: t1 })
    await removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [REPLY], threadDeleted: false })
    expect(messages.has(REPLY)).toBe(false)
    expect(messages.has(ROOT)).toBe(true)
    expect(conversations.get(ROOT)).toMatchObject({ summary: SECRET_ROOT, updatedAt: t0 })
    expect(JSON.stringify(conversations.get(ROOT))).not.toContain(SECRET_REPLY)
  })

  it("leaves no ghost: a deleted thread with only mirror content is purged, children first, in one transaction", async () => {
    const { db, messages, conversations } = await seeded()
    await deleteThread(db)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" })
    expect(messages.size).toBe(0)
    expect(conversations.size).toBe(0)
    expect(links.deleteLinksForEntity).toHaveBeenCalledWith(db, "AGENT_CONVERSATION", [ROOT])
  })

  it("does not treat the comment authors' own participant rows as other content", async () => {
    const { db, conversations } = await seeded()
    await deleteThread(db)
    expect(db.agentConversationParticipant.count).toHaveBeenCalledWith({ where: { conversationId: ROOT, userId: { notIn: expect.arrayContaining(["user-1", "user-2"]) } } })
    expect(conversations.size).toBe(0)
  })

  it.each([
    ["an agent run", { counts: { agentRun: 1 } }],
    ["a child run", { counts: { agentChildRun: 1 } }],
    ["an inbox item", { counts: { agentInboxItem: 1 } }],
    ["a scheduled wakeup", { counts: { agentScheduledWakeup: 1 } }],
    ["a non-comment participant", { counts: { participant: 1 } }],
    ["a review", { counts: { agentConversationReview: 1 } }],
    ["an audit row", { counts: { agentAuditLog: 1 } }],
    ["a session transcript", { counts: { agentSession: 1 } }],
    ["a web search row", { counts: { agentWebSearch: 1 } }],
    ["a web fetch row", { counts: { agentWebFetch: 1 } }],
    ["a PM interview pointer", { counts: { pMInterview: 1 } }],
    ["an API key scope", { counts: { apiKey: 1 } }],
    ["an origin link", { counts: { entityLink: 1 } }],
    ["interview processing state", { interview: "{}" }],
    ["a panel-created message with no Comment row", { panelMessages: [{ id: "panel-1", conversationId: ROOT, role: "assistant", content: "agent answer", createdAt: t2 }] }],
  ] as [string, Extra][])("archives instead of purging a deleted thread that has %s, and blanks the deleted text", async (_label, extra) => {
    const { db, conversations, messages } = await seeded(extra)
    await deleteThread(db)
    expect(db.agentConversation.deleteMany).not.toHaveBeenCalled()
    const row = conversations.get(ROOT)!
    expect(row.archivedAt).toBeInstanceOf(Date)
    expect(row.title).toBe(ARCHIVED_MIRROR_TITLE)
    expect(row.summary).toBeNull()
    expect(JSON.stringify(row)).not.toContain(SECRET_ROOT)
    expect(JSON.stringify(row)).not.toContain(SECRET_REPLY)
    expect(messages.has(ROOT)).toBe(false)
    expect(messages.has(REPLY)).toBe(false)
  })

  it("retries the delete transaction on a serialization failure", async () => {
    const { db, conversations } = await seeded()
    const real = db.$transaction.getMockImplementation()!
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "P2034" }))
    db.$transaction.mockImplementation(real)
    await deleteThread(db)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(conversations.size).toBe(0)
  })

  it("does not retry a non-retryable failure", async () => {
    const { db } = await seeded()
    db.$transaction.mockRejectedValue(new Error("boom"))
    await expect(deleteThread(db)).rejects.toThrow("boom")
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it("pages the message deletes: a 1,200-message thread is removed in bounded batches", async () => {
    const { db, messages, conversations } = fakeDb([])
    conversations.set(ROOT, { id: ROOT, userId: "user-1", updatedAt: t0 })
    const ids = Array.from({ length: 1200 }, (_, i) => `m-${i}`)
    for (const id of ids) messages.set(id, { id, conversationId: ROOT, authorUserId: "user-1", createdAt: t0 })
    // A same-id message in another conversation must not be touched (the conversationId filter is honoured).
    messages.set("other", { id: "other", conversationId: "someone-else", createdAt: t0 })
    await removeCommentMirror(db as never, { conversationId: ROOT, commentIds: ids, threadDeleted: true })
    const sizes = db.agentMessage.deleteMany.mock.calls.map(([arg]) => (arg as { where: { id: { in: string[] } } }).where.id.in.length)
    expect(sizes).toEqual([500, 500, 200])
    expect([...messages.keys()]).toEqual(["other"])
    expect(conversations.size).toBe(0)
  })

  it("is a no-op when the mirror never existed", async () => {
    const { db } = fakeDb([])
    await expect(removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [ROOT], threadDeleted: true })).resolves.toBeUndefined()
  })

  it("the after-commit wrapper swallows and logs failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    dbHolder.current = { agentMessage: { findMany: vi.fn().mockRejectedValue(new Error("boom")), deleteMany: vi.fn().mockRejectedValue(new Error("boom")) } }
    await expect(removeCommentMirrorAfterCommit({ conversationId: ROOT, commentIds: [REPLY], threadDeleted: false })).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conversation-mirror"), expect.any(Error))
    error.mockRestore()
  })
})
