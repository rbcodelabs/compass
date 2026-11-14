/**
 * The board's data path. The security-relevant half is the per-user "reviewed" flag:
 * it is written only through the shared conversation access check, is keyed by the
 * caller (so it never leaks between participants of a shared conversation), and is
 * read back only for the caller.
 */
import { describe, expect, it, vi } from "vitest"

import { deleteWorkspaceConversationReviews, listAgentBoardCards, markConversationReviewed } from "@/lib/agent-board-data"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const WS = "ws-1"
const NOW = new Date("2026-10-05T12:10:00.000Z")

function fakePrisma(opts: { access?: { userId: string } | null; conversations?: Any[]; reviews?: Any[]; reviewsError?: unknown } = {}) {
  const missing = opts.reviewsError
  return {
    agentConversation: {
      findFirst: vi.fn().mockResolvedValue(opts.access === undefined ? { userId: "owner" } : opts.access),
      findMany: vi.fn().mockResolvedValue(opts.conversations ?? []),
    },
    agentConversationReview: {
      findMany: vi.fn().mockImplementation(async () => {
        if (missing) throw missing
        return opts.reviews ?? []
      }),
      upsert: vi.fn().mockImplementation(async () => {
        if (missing) throw missing
        return {}
      }),
    },
  } as Any
}

describe("markConversationReviewed", () => {
  it("runs the shared access check (live workspace membership included) before writing anything", async () => {
    const prisma = fakePrisma({ access: { userId: "owner" } })
    const result = await markConversationReviewed(prisma, { conversationId: "c-1", workspaceId: WS, userId: "me", now: NOW })
    expect(result).toEqual({ ok: true })
    expect(prisma.agentConversation.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "c-1",
      workspaceId: WS,
      workspace: { members: { some: { userId: "me" } } },
    })
    // the access query ran before the write
    expect(prisma.agentConversation.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.agentConversationReview.upsert.mock.invocationCallOrder[0]
    )
  })

  it("refuses, and writes nothing, for a conversation the caller cannot see", async () => {
    const prisma = fakePrisma({ access: null })
    const result = await markConversationReviewed(prisma, { conversationId: "c-1", workspaceId: WS, userId: "stranger", now: NOW })
    expect(result).toEqual({ ok: false, reason: "not_found" })
    expect(prisma.agentConversationReview.upsert).not.toHaveBeenCalled()
  })

  it("keys the flag by the caller, so a participant's review never marks the owner's copy", async () => {
    const prisma = fakePrisma({ access: { userId: "owner" } })
    await markConversationReviewed(prisma, { conversationId: "c-1", workspaceId: WS, userId: "participant", now: NOW })
    const call = prisma.agentConversationReview.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ conversationId_userId: { conversationId: "c-1", userId: "participant" } })
    expect(call.create).toMatchObject({ conversationId: "c-1", workspaceId: WS, userId: "participant", reviewedAt: NOW })
    expect(call.update).toMatchObject({ reviewedAt: NOW, updatedAt: NOW })
  })

  it("reports 'unavailable' (not a crash) while the reviews migration is unapplied", async () => {
    const prisma = fakePrisma({ reviewsError: Object.assign(new Error("no table"), { code: "P2021" }) })
    const result = await markConversationReviewed(prisma, { conversationId: "c-1", workspaceId: WS, userId: "me", now: NOW })
    expect(result).toEqual({ ok: false, reason: "unavailable" })
  })

  it("rethrows an unexpected database error", async () => {
    const prisma = fakePrisma({ reviewsError: new Error("connection reset") })
    await expect(markConversationReviewed(prisma, { conversationId: "c-1", workspaceId: WS, userId: "me", now: NOW })).rejects.toThrow("connection reset")
  })
})

describe("listAgentBoardCards", () => {
  const conversation = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Chat ${id}`,
    updatedAt: new Date("2026-10-05T12:05:00.000Z"),
    _count: { messages: 3 },
    runs: [{ status: "SUCCEEDED", statusChangedAt: new Date("2026-10-05T12:04:00.000Z") }],
    ...extra,
  })

  it("lists only conversations the caller can access, via the shared predicate", async () => {
    const prisma = fakePrisma({ conversations: [conversation("a")] })
    await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    const where = prisma.agentConversation.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ workspaceId: WS, workspace: { members: { some: { userId: "me" } } } })
    expect(where.OR).toEqual(expect.arrayContaining([{ userId: "me" }]))
  })

  it("reads reviews only for the caller", async () => {
    const prisma = fakePrisma({ conversations: [conversation("a"), conversation("b")] })
    await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    expect(prisma.agentConversationReview.findMany.mock.calls[0][0].where).toMatchObject({
      userId: "me",
      workspaceId: WS,
      conversationId: { in: ["a", "b"] },
    })
  })

  it("maps message count, latest run status, review and last activity (latest of conversation and run)", async () => {
    const prisma = fakePrisma({
      conversations: [
        conversation("a", {
          updatedAt: new Date("2026-10-05T12:00:00.000Z"),
          runs: [{ status: "RUNNING", statusChangedAt: new Date("2026-10-05T12:09:00.000Z") }],
        }),
        conversation("b", { runs: [], _count: { messages: 0 }, title: null }),
      ],
      reviews: [{ conversationId: "a", reviewedAt: new Date("2026-10-05T11:00:00.000Z") }],
    })
    const cards = await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    expect(cards).toEqual([
      { id: "a", title: "Chat a", messageCount: 3, runStatus: "RUNNING", lastActivityAt: "2026-10-05T12:09:00.000Z", reviewedAt: "2026-10-05T11:00:00.000Z" },
      { id: "b", title: null, messageCount: 0, runStatus: null, lastActivityAt: "2026-10-05T12:05:00.000Z", reviewedAt: null },
    ])
  })

  it("still lists everything, as unreviewed, while the reviews migration is unapplied", async () => {
    const prisma = fakePrisma({ conversations: [conversation("a")], reviewsError: Object.assign(new Error("no table"), { code: "P2021" }) })
    const cards = await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    expect(cards).toHaveLength(1)
    expect(cards[0].reviewedAt).toBeNull()
  })

  it("falls back cleanly on P2022 when migration 119 columns are not yet applied", async () => {
    const prisma = fakePrisma()
    prisma.agentConversation.findMany
      .mockRejectedValueOnce(Object.assign(new Error("column squad_id does not exist"), { code: "P2022" }))
      .mockResolvedValueOnce([conversation("pre-119")])
    const cards = await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe("pre-119")
    expect(prisma.agentConversation.findMany).toHaveBeenCalledTimes(2)
    expect(prisma.agentConversation.findMany.mock.calls[1][0].select).not.toHaveProperty("squadId")
  })

  it("batches squad, fallback summary + PR URL, capped plan subtasks, and non-plan linked objects", async () => {
    const convId = "11111111-1111-4111-8111-111111111111"
    const oppId = "22222222-2222-4222-8222-222222222222"
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i + 1}`,
      title: `Plan step ${i + 1}`,
      status: i < 2 ? "DONE" : i === 2 ? "IN_PROGRESS" : "TODO",
    }))
    const prisma: Any = {
      ...fakePrisma({
        conversations: [
          conversation(convId, {
            squadId: "sq-1",
            summary: null,
            prUrl: null,
            runs: [
              {
                status: "RUNNING",
                substatus: null,
                currentActivity: "Updating Tasks",
                lastHeartbeatAt: new Date("2026-10-05T12:08:50.000Z"),
                statusChangedAt: new Date("2026-10-05T12:09:00.000Z"),
              },
            ],
          }),
        ],
      }),
      squad: {
        findMany: vi.fn().mockResolvedValue([{ id: "sq-1", name: "Core", color: "#6366f1" }]),
      },
      agentMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            conversationId: convId,
            content: "## Done\nOpened https://github.com/rbcodelabs/compass/pull/570 for review.",
          },
        ]),
      },
      entityLink: {
        findMany: vi.fn().mockImplementation(async (args: Any) => {
          const lt = args?.where?.linkType
          if (lt === "TASK_CREATED_FROM") {
            return tasks.map((t, idx) => ({
              id: `el-t-${idx}`,
              linkType: "TASK_CREATED_FROM",
              fromType: "TASK",
              fromId: t.id,
              toType: "AGENT_CONVERSATION",
              toId: convId,
              source: "AGENT",
              createdById: null,
              createdAt: new Date(1_000 + idx),
            }))
          }
          // Conversation -> Object links: includes plan tasks (which must NOT duplicate as footer chips) + 1 Opportunity
          return [
            ...tasks.map((t, idx) => ({
              id: `el-c-${idx}`,
              linkType: "CONVERSATION_CREATED",
              fromId: convId,
              toType: "TASK",
              toId: t.id,
              createdAt: new Date(1_000 + idx),
            })),
            {
              id: "el-opp",
              linkType: "CONVERSATION_CREATED",
              fromId: convId,
              toType: "OPPORTUNITY",
              toId: oppId,
              createdAt: new Date(2_000),
            },
          ]
        }),
      },
      taskLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      task: {
        findMany: vi.fn().mockResolvedValue(tasks),
      },
      opportunity: {
        findMany: vi.fn().mockResolvedValue([{ id: oppId, title: "Rich Agent Management", seqPrefix: "OPP", seqNumber: 42 }]),
      },
    }

    const [rich] = await listAgentBoardCards(prisma, { workspaceId: WS, userId: "me" })
    expect(rich.squad).toEqual({ id: "sq-1", name: "Core", color: "#6366f1" })
    expect(rich.currentActivity).toBe("Updating Tasks")
    expect(rich.lastHeartbeatAt).toBe("2026-10-05T12:08:50.000Z")
    expect(rich.summary).toBe("Done Opened https://github.com/rbcodelabs/compass/pull/570 for review.")
    expect(rich.prUrl).toBe("https://github.com/rbcodelabs/compass/pull/570")
    expect(rich.subtasks?.completed).toBe(2)
    expect(rich.subtasks?.total).toBe(6)
    expect(rich.subtasks?.items).toHaveLength(5)
    expect(rich.subtasks?.items[2].status).toBe("in_progress")
    // Plan subtasks are filtered out of footer linkedObjects so only the real Opportunity chip remains
    expect(rich.linkedObjectCount).toBe(1)
    expect(rich.linkedObjects).toEqual([
      { entityType: "OPPORTUNITY", entityId: oppId, title: "Rich Agent Management", kind: "CREATED" },
    ])
  })
})

describe("deleteWorkspaceConversationReviews", () => {
  it("deletes every review in the workspace (and only that workspace)", async () => {
    const prisma = fakePrisma()
    prisma.agentConversationReview.deleteMany = vi.fn().mockResolvedValue({ count: 3 })
    await deleteWorkspaceConversationReviews(prisma, WS)
    expect(prisma.agentConversationReview.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: WS } })
  })

  it("is a no-op while the reviews migration is unapplied, and rethrows anything else", async () => {
    const missing = fakePrisma()
    missing.agentConversationReview.deleteMany = vi.fn().mockRejectedValue(Object.assign(new Error("no table"), { code: "P2021" }))
    await expect(deleteWorkspaceConversationReviews(missing, WS)).resolves.toBeUndefined()
    const broken = fakePrisma()
    broken.agentConversationReview.deleteMany = vi.fn().mockRejectedValue(new Error("connection reset"))
    await expect(deleteWorkspaceConversationReviews(broken, WS)).rejects.toThrow("connection reset")
  })
})
