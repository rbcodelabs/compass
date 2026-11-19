import { beforeEach, describe, expect, it, vi } from "vitest"

const purge = vi.hoisted(() => ({ purgeConversations: vi.fn() }))
vi.mock("@/lib/agent-conversation-purge", () => ({ purgeConversations: purge.purgeConversations }))
const links = vi.hoisted(() => ({ recordConversationLink: vi.fn() }))
vi.mock("@/lib/links/conversation-links", () => ({
  isConversationLinkTarget: (type: string) => type === "OPPORTUNITY",
  recordConversationLink: links.recordConversationLink,
}))
const dbHolder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => dbHolder.current }))

import {
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

type Row = Record<string, unknown>

/** In-memory stand-in for the handful of delegates the mirror touches. */
function fakeDb(comments: Row[], extra: { runs?: number; childRuns?: number; panelMessages?: Row[]; interview?: string | null } = {}) {
  const conversations = new Map<string, Row>()
  const messages = new Map<string, Row>()
  for (const message of extra.panelMessages ?? []) messages.set(message.id as string, message)
  const db = {
    comment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => comments.find((c) => c.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { parentId?: string; workspaceId?: string } }) =>
        comments.filter((c) => (where.parentId ? c.parentId === where.parentId : true)),
      ),
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
        return found ? { id: found.id, interviewProcessingJson: extra.interview ?? null } : null
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const found = conversations.get(where.id)
        if (!found) return { count: 0 }
        conversations.set(where.id, { ...found, ...data })
        return { count: 1 }
      }),
    },
    agentMessage: {
      upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
        const existing = messages.get(where.id)
        messages.set(where.id, existing ? { ...existing, ...update } : { ...create })
        return messages.get(where.id)
      }),
      count: vi.fn(async ({ where }: { where: { conversationId: string; id: { notIn: string[] } } }) =>
        [...messages.values()].filter((m) => m.conversationId === where.conversationId && !where.id.notIn.includes(m.id as string)).length,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [...messages.values()].filter((m) => where.id.in.includes(m.id as string)).map((m) => ({ id: m.id })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        let count = 0
        for (const id of where.id.in) if (messages.delete(id)) count++
        return { count }
      }),
    },
    agentRun: { count: vi.fn(async () => extra.runs ?? 0) },
    agentChildRun: { count: vi.fn(async () => extra.childRuns ?? 0) },
  }
  return { db, conversations, messages }
}

const root = (over: Row = {}): Row => ({
  id: ROOT, workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: null, authorId: "user-1",
  authorName: "Rick", authorType: "HUMAN", source: "UI", body: "Should we unify?", status: "OPEN",
  createdAt: t0, updatedAt: t0, solutionPlanProposal: null, ...over,
})
const reply = (over: Row = {}): Row => ({
  id: REPLY, workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: ROOT, authorId: "user-2",
  authorName: "Dana", authorType: "HUMAN", source: "UI", body: "Yes.", status: "OPEN",
  createdAt: t1, updatedAt: t1, solutionPlanProposal: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  purge.purgeConversations.mockResolvedValue({ purged: [], kept: [] })
  links.recordConversationLink.mockResolvedValue("created")
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
    expect(conversations.size).toBe(0)
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
})

describe("mirrorCommentAfterCommit", () => {
  it("never throws when the mirror write fails, and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    dbHolder.current = { comment: { findUnique: vi.fn().mockRejectedValue(new Error("mirror down")) } }
    await expect(mirrorCommentAfterCommit(ROOT)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conversation-mirror"), expect.any(Error))
    error.mockRestore()
  })
})

describe("removeCommentMirror", () => {
  async function seeded(extra: Parameters<typeof fakeDb>[1] = {}) {
    const fake = fakeDb([root(), reply()], extra)
    await ensureConversationForComment(fake.db as never, ROOT)
    return fake
  }

  it("removes only the reply message when a reply is deleted", async () => {
    const { db, conversations, messages } = await seeded()
    await removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [REPLY], threadDeleted: false })
    expect(messages.has(REPLY)).toBe(false)
    expect(messages.has(ROOT)).toBe(true)
    expect(conversations.has(ROOT)).toBe(true)
    expect(purge.purgeConversations).not.toHaveBeenCalled()
  })

  it("leaves no ghost: a deleted thread with no agent activity has its messages and conversation purged", async () => {
    const { db, messages, conversations } = await seeded()
    await removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [ROOT, REPLY], threadDeleted: true })
    expect(messages.size).toBe(0)
    expect(purge.purgeConversations).toHaveBeenCalledWith(db, [ROOT])
    expect(conversations.get(ROOT)?.archivedAt ?? null).toBeNull()
  })

  it.each([
    ["an agent run", { runs: 1 }],
    ["a child run", { childRuns: 1 }],
    ["a PM interview", { interview: "{}" }],
    ["a panel-created message with no Comment row", { panelMessages: [{ id: "panel-1", conversationId: ROOT, role: "assistant", content: "agent answer" }] }],
  ])("archives instead of removing a deleted thread that has %s", async (_label, extra) => {
    const { db, conversations, messages } = await seeded(extra)
    await removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [ROOT, REPLY], threadDeleted: true })
    expect(purge.purgeConversations).not.toHaveBeenCalled()
    expect(conversations.get(ROOT)?.archivedAt).toBeInstanceOf(Date)
    // The deleted comments' own mirrors are gone; the agent/panel content stays.
    expect(messages.has(ROOT)).toBe(false)
    expect(messages.has(REPLY)).toBe(false)
  })

  it("is a no-op when the mirror never existed", async () => {
    const { db } = fakeDb([])
    await expect(removeCommentMirror(db as never, { conversationId: ROOT, commentIds: [ROOT], threadDeleted: true })).resolves.toBeUndefined()
  })

  it("the after-commit wrapper swallows and logs failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    dbHolder.current = { agentMessage: { findMany: vi.fn().mockRejectedValue(new Error("boom")), deleteMany: vi.fn().mockRejectedValue(new Error("boom")) } }
    await expect(removeCommentMirrorAfterCommit({ conversationId: ROOT, commentIds: [ROOT], threadDeleted: true })).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conversation-mirror"), expect.any(Error))
    error.mockRestore()
  })
})
