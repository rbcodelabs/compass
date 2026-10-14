import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig, getFollowable } from "@/lib/followable"
import { resetFollowingAvailabilityCache } from "@/lib/following-flag"
import { runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => holder.db }))

import { followTool, listNotificationsTool, markReadTool, unfollowTool } from "@/lib/follow-tool-handlers"

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const OTHER = "00000000-0000-4000-8000-0000000000a2"
const AGENT = "00000000-0000-4000-8000-0000000000c1"
const TASK = "00000000-0000-4000-8000-0000000000b1"

let fake: ReturnType<typeof createFakeFollowDb>
const asUser = <T>(fn: () => T, actor: Partial<McpActor> = {}) => runWithMcpActor({ userId: ME, purpose: "USER", ...actor }, fn)
const data = (result: { structuredContent: { data: unknown } }) => result.structuredContent.data as Record<string, unknown>

beforeEach(() => {
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 2
  resetFollowingAvailabilityCache()
  fake = createFakeFollowDb()
  holder.db = fake.db
  fake.member(WS, ME)
  fake.member(WS, OTHER)
  vi.spyOn(getFollowable("TASK")!, "resolveWorkspace").mockImplementation(async (id) => (id === TASK ? { workspaceId: WS } : null))
  vi.spyOn(getFollowable("TASK")!, "resolveDisplay").mockImplementation(async (_ws, ids) => new Map(ids.map((id) => [id, { title: "Ship it", path: `tasks/${id}` }])))
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("follow and unfollow", () => {
  it("follows a subject for the calling user and reports the ID on its own line", async () => {
    const result = await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    expect(result.structuredContent.ok).toBe(true)
    expect(result.content[0].text).toContain(`\nID: ${TASK}`)
    expect(fake.tables.follow).toMatchObject([{ userId: ME, subjectType: "TASK", subjectId: TASK, state: "FOLLOWING", source: "MANUAL" }])
  })

  it("is idempotent", async () => {
    await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    const again = await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    expect(again.structuredContent.ok).toBe(true)
    expect(data(again).status).toBe("already_following")
    expect(fake.tables.follow).toHaveLength(1)
  })

  it("unfollow leaves a MUTED tombstone so auto-follow cannot undo it", async () => {
    await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    const result = await asUser(() => unfollowTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    expect(result.structuredContent.ok).toBe(true)
    expect(fake.tables.follow).toMatchObject([{ state: "MUTED" }])
  })

  it("returns a clear failure, not a throw, for unknown subjects, other workspaces and unshipped types", async () => {
    const missing = await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: "00000000-0000-4000-8000-0000000000ff" }))
    expect(missing).toMatchObject({ structuredContent: { ok: false } })
    expect(missing.content[0].text).toMatch(/not found/i)
    const inactive = await asUser(() => followTool({ workspaceId: WS, subjectType: "EXPERIMENT", subjectId: TASK }))
    expect(inactive.structuredContent.ok).toBe(false)
    expect(inactive.content[0].text).toMatch(/cannot be followed yet/)
    expect(fake.tables.follow).toHaveLength(0)
  })

  it("rejects non-members of the declared workspace", async () => {
    const result = await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }), { userId: "00000000-0000-4000-8000-0000000000ee" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/members/i)
  })

  it("tells the caller when following is not enabled", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    const result = await asUser(() => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK }))
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/not enabled/i)
  })
})

describe("agent-scoped tokens and non-user credentials get a clear error", () => {
  const calls = [
    ["follow", () => followTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK })],
    ["unfollow", () => unfollowTool({ workspaceId: WS, subjectType: "TASK", subjectId: TASK })],
    ["list_notifications", () => listNotificationsTool({ workspaceId: WS })],
    ["mark_read", () => markReadTool({ workspaceId: WS, all: true })],
  ] as const

  it.each(calls)("%s refuses an agent identity without touching anyone's inbox", async (_name, call) => {
    for (const purpose of ["AGENT", "AGENT_TURN"] as const) {
      const result = await runWithMcpActor({ userId: ME, purpose, agentId: AGENT }, call)
      expect(result.structuredContent.ok).toBe(false)
      expect(result.content[0].text).toMatch(/agent/i)
      expect(result.content[0].text).toMatch(/person|human|user/i)
    }
    expect(fake.tables.follow).toHaveLength(0)
    expect(fake.tables.notification).toHaveLength(0)
  })

  it.each(calls)("%s refuses a service credential that has no user", async (_name, call) => {
    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, call)
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/user/i)
  })
})

describe("list_notifications and mark_read", () => {
  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    fake.db.notification.create({
      data: { workspaceId: WS, recipientUserId: ME, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: OTHER, payload: { from: "TODO", to: "DONE" }, dedupeKey: `k${n}`, createdAt: new Date(2026, 0, 1, 0, n), ...extra },
    })

  it("lists only the caller's notifications with display data, an unread count and no secrets", async () => {
    fake.tables.user.push({ id: OTHER, name: "Ada" })
    await seed(1)
    await seed(2, { readAt: new Date() })
    await fake.db.notification.create({ data: { workspaceId: WS, recipientUserId: OTHER, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ME, payload: {}, dedupeKey: "theirs" } })
    const result = await asUser(() => listNotificationsTool({ workspaceId: WS }))
    expect(result.structuredContent.ok).toBe(true)
    const payload = data(result) as { items: Array<Record<string, unknown>>; count: number; unreadCount: number; nextCursor: string | null }
    expect(payload.count).toBe(2)
    expect(payload.unreadCount).toBe(1)
    expect(payload.items[0]).toMatchObject({ kind: "STATUS_CHANGED", subjectType: "TASK", subjectId: TASK, subjectTitle: "Ship it", actor: { type: "USER", name: "Ada" }, payload: { from: "TODO", to: "DONE" } })
  })

  it("can filter to unread", async () => {
    await seed(1, { readAt: new Date() })
    await seed(2)
    const payload = data(await asUser(() => listNotificationsTool({ workspaceId: WS, unreadOnly: true }))) as { count: number }
    expect(payload.count).toBe(1)
  })

  it("marks specific notifications read, only the caller's own", async () => {
    const mine = await seed(1) as { id: string }
    const theirs = await fake.db.notification.create({ data: { workspaceId: WS, recipientUserId: OTHER, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: ME, payload: {}, dedupeKey: "theirs" } }) as { id: string }
    const result = await asUser(() => markReadTool({ workspaceId: WS, notificationIds: [mine.id, theirs.id] }))
    expect(result.structuredContent.ok).toBe(true)
    expect(data(result).marked).toBe(1)
    expect(fake.tables.notification.find((n) => n.id === theirs.id)?.readAt).toBeNull()
    expect(fake.tables.notification.find((n) => n.id === mine.id)?.readAt).toBeInstanceOf(Date)
  })

  it("marks everything read with all:true", async () => {
    await seed(1)
    await seed(2)
    const result = await asUser(() => markReadTool({ workspaceId: WS, all: true }))
    expect(data(result).marked).toBe(2)
  })

  it("requires exactly one of notificationIds or all", async () => {
    expect((await asUser(() => markReadTool({ workspaceId: WS }))).structuredContent.ok).toBe(false)
    expect((await asUser(() => markReadTool({ workspaceId: WS, all: true, notificationIds: [TASK] }))).structuredContent.ok).toBe(false)
  })

  it("a removed member sees nothing", async () => {
    await seed(1)
    const result = await asUser(() => listNotificationsTool({ workspaceId: WS }), { userId: "00000000-0000-4000-8000-0000000000ee" })
    expect((data(result) as { count: number }).count).toBe(0)
  })
})
