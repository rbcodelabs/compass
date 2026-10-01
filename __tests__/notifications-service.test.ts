import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig, getFollowable } from "@/lib/followable"
import { resetFollowingAvailabilityCache } from "@/lib/following-flag"
import {
  MAX_RECIPIENTS_PER_EVENT,
  emitSubjectEvent,
  getEmitFailureCount,
  listNotifications,
  markAllRead,
  markRead,
  resetEmitFailureCount,
  unreadCount,
  type SubjectEvent,
} from "@/lib/notifications"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const research = vi.hoisted(() => ({ enabled: true }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => research.enabled }))

const WS = "00000000-0000-4000-8000-000000000001"
const ACTOR = "00000000-0000-4000-8000-0000000000a0"
const U1 = "00000000-0000-4000-8000-0000000000a1"
const U2 = "00000000-0000-4000-8000-0000000000a2"
const U3 = "00000000-0000-4000-8000-0000000000a3"
const TASK = "00000000-0000-4000-8000-0000000000b1"
const AGENT = "00000000-0000-4000-8000-0000000000c1"

let fake: ReturnType<typeof createFakeFollowDb>

const follow = (userId: string, state = "FOLLOWING", subjectType = "TASK", subjectId = TASK) =>
  fake.tables.follow.push({ id: `${userId}-${subjectType}`, workspaceId: WS, userId, subjectType, subjectId, state, source: "MANUAL", createdAt: new Date(), updatedAt: new Date() })

const statusEvent = (overrides: Partial<SubjectEvent> = {}): SubjectEvent => ({
  workspaceId: WS,
  subjectType: "TASK",
  subjectId: TASK,
  kind: "STATUS_CHANGED",
  actor: { type: "USER", id: ACTOR },
  payload: { from: "TODO", to: "DONE" },
  dedupeKey: `status:${TASK}:1`,
  ...overrides,
})

beforeEach(() => {
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 3
  research.enabled = true
  resetFollowingAvailabilityCache()
  resetEmitFailureCount()
  fake = createFakeFollowDb()
  for (const user of [ACTOR, U1, U2, U3]) fake.member(WS, user)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const recipients = () => fake.tables.notification.map((n) => n.recipientUserId).sort()

describe("emitSubjectEvent fan-out", () => {
  it("writes one minimal row per FOLLOWING member", async () => {
    follow(U1)
    follow(U2)
    const result = await emitSubjectEvent(statusEvent(), fake.db)
    expect(result).toEqual({ status: "emitted", recipients: 2, created: 2 })
    expect(recipients()).toEqual([U1, U2])
    expect(fake.tables.notification[0]).toMatchObject({
      workspaceId: WS, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ACTOR,
      payload: { from: "TODO", to: "DONE" }, dedupeKey: `status:${TASK}:1`,
    })
  })

  it("never notifies the actor, even when they follow the subject", async () => {
    follow(ACTOR)
    follow(U1)
    await emitSubjectEvent(statusEvent(), fake.db)
    expect(recipients()).toEqual([U1])
  })

  it("also excludes users the caller names, for an agent acting through a user's own credential (open question 6)", async () => {
    follow(U1)
    follow(U2)
    await emitSubjectEvent(statusEvent({ actor: { type: "AGENT", id: AGENT }, excludeUserIds: [U1] }), fake.db)
    expect(recipients()).toEqual([U2])
    expect(fake.tables.notification[0]).toMatchObject({ actorType: "AGENT", actorId: AGENT })
  })

  it("notifies the responsible owner like any follower when an autonomous agent acts", async () => {
    follow(U1)
    await emitSubjectEvent(statusEvent({ actor: { type: "AGENT", id: AGENT } }), fake.db)
    expect(recipients()).toEqual([U1])
  })

  it("skips MUTED tombstones", async () => {
    follow(U1, "MUTED")
    follow(U2)
    await emitSubjectEvent(statusEvent(), fake.db)
    expect(recipients()).toEqual([U2])
  })

  it("never writes a row for a follower who is no longer a workspace member", async () => {
    follow(U1)
    follow("ex-member")
    await emitSubjectEvent(statusEvent(), fake.db)
    expect(recipients()).toEqual([U1])
  })

  it("applies the type's own access rule (research studies need research capture)", async () => {
    const study = "00000000-0000-4000-8000-0000000000d1"
    follow(U1, "FOLLOWING", "RESEARCH_STUDY", study)
    research.enabled = false
    const off = await emitSubjectEvent(statusEvent({ subjectType: "RESEARCH_STUDY", subjectId: study, dedupeKey: "k1" }), fake.db)
    expect(off).toEqual({ status: "skipped", reason: "no_recipients" })
    research.enabled = true
    await emitSubjectEvent(statusEvent({ subjectType: "RESEARCH_STUDY", subjectId: study, dedupeKey: "k2" }), fake.db)
    expect(recipients()).toEqual([U1])
  })

  it("stores EXTERNAL and SYSTEM actors with a null actor id and never an email", async () => {
    follow(U1)
    await emitSubjectEvent(statusEvent({ kind: "COMMENT_ADDED", actor: { type: "EXTERNAL", id: "visitor@example.com" }, payload: { commentId: "c1" }, dedupeKey: "comment:c1" }), fake.db)
    expect(fake.tables.notification[0]).toMatchObject({ actorType: "EXTERNAL", actorId: null })
    expect(JSON.stringify(fake.tables.notification)).not.toContain("example.com")
  })

  it("is idempotent: replaying the same event adds nothing", async () => {
    follow(U1)
    const first = await emitSubjectEvent(statusEvent(), fake.db)
    const replay = await emitSubjectEvent(statusEvent(), fake.db)
    expect(first).toMatchObject({ created: 1 })
    expect(replay).toEqual({ status: "emitted", recipients: 1, created: 0 })
    expect(fake.tables.notification).toHaveLength(1)
  })

  it("keeps distinct events distinct by dedupe key", async () => {
    follow(U1)
    await emitSubjectEvent(statusEvent({ dedupeKey: "status:1" }), fake.db)
    await emitSubjectEvent(statusEvent({ dedupeKey: "status:2", payload: { from: "DONE", to: "TODO" } }), fake.db)
    expect(fake.tables.notification).toHaveLength(2)
  })

  it("caps recipients per event and logs when exceeded", async () => {
    for (let i = 0; i < MAX_RECIPIENTS_PER_EVENT + 2; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}9`
      fake.member(WS, id)
      follow(id)
    }
    const result = await emitSubjectEvent(statusEvent(), fake.db)
    expect(result).toEqual({ status: "emitted", recipients: MAX_RECIPIENTS_PER_EVENT, created: MAX_RECIPIENTS_PER_EVENT })
    expect(console.warn).toHaveBeenCalled()
  })
})

describe("emitSubjectEvent payload", () => {
  it("keeps only machine facts: no titles, no comment excerpts, no non-string values", async () => {
    follow(U1)
    await emitSubjectEvent(
      statusEvent({ kind: "COMMENT_REPLIED", payload: { commentId: "c2", parentCommentId: "c1", title: "Secret roadmap", excerpt: "private text", from: 7 as never } as never, dedupeKey: "comment:c2" }),
      fake.db,
    )
    expect(fake.tables.notification[0].payload).toEqual({ commentId: "c2", parentCommentId: "c1" })
  })

  it("bounds string values", async () => {
    follow(U1)
    await emitSubjectEvent(statusEvent({ payload: { from: "x".repeat(500), to: "DONE" } }), fake.db)
    expect(String((fake.tables.notification[0].payload as { from: string }).from).length).toBeLessThanOrEqual(80)
  })
})

describe("emitSubjectEvent gating", () => {
  it("does nothing when the flag is off", async () => {
    follow(U1)
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect(await emitSubjectEvent(statusEvent(), fake.db)).toEqual({ status: "skipped", reason: "disabled" })
    expect(fake.tables.notification).toHaveLength(0)
  })

  it("stays silent for a subject type whose slice has not shipped", async () => {
    follow(U1)
    followableConfig.shippedSlice = 1
    expect(await emitSubjectEvent(statusEvent(), fake.db)).toEqual({ status: "skipped", reason: "inactive_subject_type" })
    followableConfig.shippedSlice = 2
    expect(await emitSubjectEvent(statusEvent({ subjectType: "EXPERIMENT" }), fake.db)).toEqual({ status: "skipped", reason: "inactive_subject_type" })
  })

  it("refuses kinds a type does not emit: Docs have no status, Metrics no comments, only Tasks assign", async () => {
    follow(U1)
    follow(U1, "FOLLOWING", "DOC")
    follow(U1, "FOLLOWING", "METRIC")
    expect(await emitSubjectEvent(statusEvent({ subjectType: "DOC" }), fake.db)).toEqual({ status: "skipped", reason: "kind_not_emitted" })
    expect(await emitSubjectEvent(statusEvent({ subjectType: "METRIC", kind: "COMMENT_ADDED" }), fake.db)).toEqual({ status: "skipped", reason: "kind_not_emitted" })
    expect(await emitSubjectEvent(statusEvent({ subjectType: "OPPORTUNITY", kind: "ASSIGNED" }), fake.db)).toEqual({ status: "skipped", reason: "kind_not_emitted" })
    expect(await emitSubjectEvent(statusEvent({ kind: "ASSIGNED", payload: {}, dedupeKey: "assigned:1" }), fake.db)).toMatchObject({ status: "emitted" })
  })

  it("reports no_followers without touching the notification table", async () => {
    const create = vi.spyOn(fake.db.notification, "createMany")
    expect(await emitSubjectEvent(statusEvent(), fake.db)).toEqual({ status: "skipped", reason: "no_followers" })
    expect(create).not.toHaveBeenCalled()
  })
})

describe("emitSubjectEvent is best effort", () => {
  it("never throws, logs, and counts the failure so a rising count can trigger the outbox revisit", async () => {
    follow(U1)
    vi.spyOn(fake.db.notification, "createMany").mockRejectedValue(new Error("db down"))
    await expect(emitSubjectEvent(statusEvent(), fake.db)).resolves.toEqual({ status: "failed" })
    expect(console.error).toHaveBeenCalled()
    expect(getEmitFailureCount()).toBe(1)
  })

  it("treats a malformed event as a failure rather than throwing into the caller's request", async () => {
    follow(U1)
    await expect(emitSubjectEvent(statusEvent({ dedupeKey: "" }), fake.db)).resolves.toEqual({ status: "failed" })
    await expect(emitSubjectEvent(statusEvent({ dedupeKey: "k".repeat(201) }), fake.db)).resolves.toEqual({ status: "failed" })
    await expect(emitSubjectEvent(statusEvent({ kind: "MENTIONED" as never }), fake.db)).resolves.toEqual({ status: "failed" })
    expect(getEmitFailureCount()).toBe(3)
  })
})

describe("listNotifications", () => {
  const seed = (recipient: string, n: number, extra: Record<string, unknown> = {}) =>
    fake.db.notification.create({
      data: {
        workspaceId: WS, recipientUserId: recipient, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ACTOR,
        payload: { from: "A", to: "B" }, dedupeKey: `k${n}-${recipient}`, createdAt: new Date(2026, 0, 1, 0, n), ...extra,
      },
    })

  beforeEach(() => {
    fake.tables.user.push({ id: ACTOR, name: "Ada" })
    fake.tables.agent.push({ id: AGENT, name: "Helper" })
    vi.spyOn(getFollowable("TASK")!, "resolveDisplay").mockImplementation(async (_ws, ids) => new Map(ids.map((id) => [id, { title: "Ship it", path: `tasks/${id}` }])))
  })

  it("returns nothing when the flag is off or the user is not a current member", async () => {
    await seed(U1, 1)
    expect((await listNotifications(U1, WS, { prisma: fake.db })).items).toHaveLength(1)
    expect((await listNotifications("ex-member", WS, { prisma: fake.db })).items).toEqual([])
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect((await listNotifications(U1, WS, { prisma: fake.db })).items).toEqual([])
  })

  it("only ever returns the caller's own rows, newest first, with display resolved at read time", async () => {
    await seed(U1, 1)
    await seed(U1, 2)
    await seed(U2, 3)
    const { items } = await listNotifications(U1, WS, { prisma: fake.db })
    expect(items.map((i) => i.createdAt.getMinutes())).toEqual([2, 1])
    expect(items[0]).toMatchObject({ kind: "STATUS_CHANGED", subject: { title: "Ship it", path: `tasks/${TASK}` }, actor: { type: "USER", id: ACTOR, name: "Ada" }, read: false })
  })

  it("shows a deleted or renamed subject as unavailable instead of throwing or leaking stale content", async () => {
    vi.spyOn(getFollowable("TASK")!, "resolveDisplay").mockResolvedValue(new Map())
    await seed(U1, 1)
    const { items } = await listNotifications(U1, WS, { prisma: fake.db })
    expect(items).toHaveLength(1)
    expect(items[0].subject).toBeNull()
  })

  it("drops rows whose subject the user may no longer see", async () => {
    const study = "00000000-0000-4000-8000-0000000000d1"
    vi.spyOn(getFollowable("RESEARCH_STUDY")!, "resolveDisplay").mockResolvedValue(new Map([[study, { title: "Study", path: `capture/studies/${study}` }]]))
    await seed(U1, 1, { subjectType: "RESEARCH_STUDY", subjectId: study })
    await seed(U1, 2)
    research.enabled = false
    const { items } = await listNotifications(U1, WS, { prisma: fake.db })
    expect(items.map((i) => i.subjectType)).toEqual(["TASK"])
  })

  it("names agent and external actors without exposing an email", async () => {
    await seed(U1, 1, { actorType: "AGENT", actorId: AGENT })
    await seed(U1, 2, { actorType: "EXTERNAL", actorId: null })
    const { items } = await listNotifications(U1, WS, { prisma: fake.db })
    expect(items.map((i) => [i.actor.type, i.actor.name])).toEqual([["EXTERNAL", "Someone outside your team"], ["AGENT", "Helper"]])
  })

  it("paginates by cursor without gaps or repeats", async () => {
    for (let n = 1; n <= 5; n++) await seed(U1, n)
    const first = await listNotifications(U1, WS, { limit: 2, prisma: fake.db })
    expect(first.items.map((i) => i.createdAt.getMinutes())).toEqual([5, 4])
    expect(first.nextCursor).toBeTruthy()
    const second = await listNotifications(U1, WS, { limit: 2, cursor: first.nextCursor!, prisma: fake.db })
    expect(second.items.map((i) => i.createdAt.getMinutes())).toEqual([3, 2])
    const third = await listNotifications(U1, WS, { limit: 2, cursor: second.nextCursor!, prisma: fake.db })
    expect(third.items.map((i) => i.createdAt.getMinutes())).toEqual([1])
    expect(third.nextCursor).toBeNull()
  })

  it("coalesces on read by grouping a page's rows per subject, without touching stored rows", async () => {
    const other = "00000000-0000-4000-8000-0000000000b2"
    await seed(U1, 1)
    await seed(U1, 2, { subjectId: other })
    await seed(U1, 3)
    await seed(U1, 4, { readAt: new Date() })
    const { groups } = await listNotifications(U1, WS, { prisma: fake.db })
    expect(groups.map((g) => [g.subjectId, g.items.length, g.unreadCount])).toEqual([[TASK, 3, 2], [other, 1, 1]])
    expect(fake.tables.notification).toHaveLength(4)
  })

  it("rejects a malformed cursor by starting from the top rather than throwing", async () => {
    await seed(U1, 1)
    const { items } = await listNotifications(U1, WS, { cursor: "garbage", prisma: fake.db })
    expect(items).toHaveLength(1)
  })
})

describe("unreadCount", () => {
  let serial = 0
  const seedUnread = async (count: number, readAt: Date | null = null) => {
    for (let i = 0; i < count; i++) {
      await fake.db.notification.create({
        data: { workspaceId: WS, recipientUserId: U1, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ACTOR, dedupeKey: `u${serial++}`, readAt },
      })
    }
  }

  it("counts unread rows only, bounded at 99 with an overflow flag", async () => {
    await seedUnread(3)
    await seedUnread(2, new Date())
    expect(await unreadCount(U1, WS, fake.db)).toEqual({ count: 3, overflow: false })
    await seedUnread(120)
    expect(await unreadCount(U1, WS, fake.db)).toEqual({ count: 99, overflow: true })
  })

  it("is zero for a non-member or when the flag is off", async () => {
    await seedUnread(3)
    expect(await unreadCount("ex-member", WS, fake.db)).toEqual({ count: 0, overflow: false })
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect(await unreadCount(U1, WS, fake.db)).toEqual({ count: 0, overflow: false })
  })
})

describe("markRead and markAllRead", () => {
  const seed = (recipient: string, key: string, extra: Record<string, unknown> = {}) =>
    fake.db.notification.create({
      data: { workspaceId: WS, recipientUserId: recipient, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ACTOR, dedupeKey: key, ...extra },
    }) as Promise<{ id: string }>

  it("marks only the caller's own unread rows", async () => {
    const mine = await seed(U1, "a")
    const theirs = await seed(U2, "b")
    const count = await markRead(U1, WS, [mine.id, theirs.id], fake.db)
    expect(count).toBe(1)
    expect(fake.tables.notification.find((n) => n.id === theirs.id)!.readAt).toBeNull()
    expect(fake.tables.notification.find((n) => n.id === mine.id)!.readAt).toBeInstanceOf(Date)
  })

  it("markAllRead marks everything up to the cursor and leaves later arrivals unread", async () => {
    const before = new Date(2026, 5, 1)
    await seed(U1, "old", { createdAt: new Date(2026, 4, 1) })
    await seed(U1, "new", { createdAt: new Date(2026, 6, 1) })
    const result = await markAllRead(U1, WS, { before, prisma: fake.db })
    expect(result.marked).toBe(1)
    expect(fake.tables.notification.find((n) => n.dedupeKey === "new")!.readAt).toBeNull()
  })

  it("batches under the row limit", async () => {
    for (let i = 0; i < 2300; i++) fake.tables.notification.push({ id: `n${i}`, workspaceId: WS, recipientUserId: U1, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: null, payload: {}, dedupeKey: `bulk${i}`, readAt: null, createdAt: new Date(2026, 0, 1) })
    const updateMany = vi.spyOn(fake.db.notification, "updateMany")
    const result = await markAllRead(U1, WS, { prisma: fake.db, now: new Date(2026, 1, 1) })
    expect(result.marked).toBe(2300)
    for (const [args] of updateMany.mock.calls) expect(((args as { where: { id: { in: string[] } } }).where.id.in).length).toBeLessThanOrEqual(1000)
  })

  it("lazily prunes read rows past the retention window but never unread ones", async () => {
    const now = new Date(2026, 8, 1)
    await seed(U1, "old-read", { readAt: new Date(2026, 0, 2), createdAt: new Date(2026, 0, 1) })
    await seed(U1, "old-unread", { createdAt: new Date(2026, 0, 1) })
    await seed(U1, "recent-read", { readAt: new Date(2026, 7, 30), createdAt: new Date(2026, 7, 29) })
    await seed(U2, "someone-elses-old-read", { readAt: new Date(2026, 0, 2), createdAt: new Date(2026, 0, 1) })
    const result = await markAllRead(U1, WS, { prisma: fake.db, now, before: now })
    // Pruning looks at read state before this call marks anything, so the old unread row survives
    // even though it is now read; a later mark-all-read prunes it.
    expect(result.pruned).toBe(1)
    expect(fake.tables.notification.map((n) => n.dedupeKey).sort()).toEqual(["old-unread", "recent-read", "someone-elses-old-read"])
  })
})
