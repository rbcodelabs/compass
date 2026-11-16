import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setFeatureTables, setModules } from "./helpers/modules"
import { followableConfig, getFollowable } from "@/lib/followable"
import { resetFollowingAvailabilityCache } from "@/lib/following-flag"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => holder.db }))

import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { GET as getUnread } from "@/app/api/notifications/unread/route"

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const ACTOR = "00000000-0000-4000-8000-0000000000a2"
const TASK_1 = "00000000-0000-4000-8000-0000000000b1"
const TASK_2 = "00000000-0000-4000-8000-0000000000b2"
const DELETED_TASK = "00000000-0000-4000-8000-0000000000b9"
const DOC_1 = "00000000-0000-4000-8000-0000000000d1"
const Q = "orgSlug=acme&workspaceSlug=ws"

let fake: ReturnType<typeof createFakeFollowDb>

beforeEach(() => {
  setModules({ following: true })
  setFeatureTables({ following: true })
  followableConfig.shippedSlice = 2
  resetFollowingAvailabilityCache()
  fake = createFakeFollowDb()
  holder.db = fake.db
  fake.member(WS, ME)
  fake.member(WS, ACTOR)
  fake.tables.user.push({ id: ACTOR, name: "Ada Lovelace" })
  vi.mocked(auth).mockResolvedValue({ user: { id: ME } } as never)
  vi.mocked(getWorkspace).mockResolvedValue({ id: WS } as never)

  vi.spyOn(getFollowable("TASK")!, "resolveDisplay").mockImplementation(async (_ws, ids) => {
    const map = new Map<string, { title: string; path: string }>()
    for (const id of ids) {
      if (id === TASK_1) map.set(id, { title: "Ship live notifications", path: `tasks/${id}` })
      if (id === TASK_2) map.set(id, { title: "Second task", path: `tasks/${id}` })
    }
    return map
  })
  vi.spyOn(getFollowable("DOC")!, "resolveDisplay").mockImplementation(async (_ws, ids) => {
    const map = new Map<string, { title: string; path: string }>()
    for (const id of ids) {
      if (id === DOC_1) map.set(id, { title: "Architecture ADR", path: `docs/${id}` })
    }
    return map
  })
})

afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("GET /api/notifications/unread", () => {
  it("preserves legacy { available, count, overflow } shape when `since` is absent", async () => {
    await fake.db.notification.create({
      data: {
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: TASK_1,
        kind: "ASSIGNED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "assigned:legacy",
      },
    })

    const res = await getUnread(new Request(`http://localhost/api/notifications/unread?${Q}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ available: true, count: 1, overflow: false })
  })

  it("returns 400 when `since` is invalid or blank", async () => {
    const bad = await getUnread(new Request(`http://localhost/api/notifications/unread?${Q}&since=not-a-date`))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: "Invalid since timestamp" })

    const blank = await getUnread(new Request(`http://localhost/api/notifications/unread?${Q}&since=`))
    expect(blank.status).toBe(400)
  })

  it("returns { available: false, count: 0, overflow: false, serverNow, alerts: [] } when following is disabled", async () => {
    setModules({ following: false })
    const res = await getUnread(
      new Request(`http://localhost/api/notifications/unread?${Q}&since=${encodeURIComponent("2026-11-15T12:00:00.000Z")}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ available: false, count: 0, overflow: false, alerts: [] })
    expect(typeof body.serverNow).toBe("string")
  })

  it("returns only unread ASSIGNED and MENTIONED alerts since cursor (with 2s overlap), omitting STATUS_CHANGED, COMMENT_ADDED, read rows, and deleted subjects", async () => {
    const t0 = new Date("2026-11-15T12:00:00.000Z")
    // Old assignment well before cursor -> counted in unread count, NOT in live alerts
    await fake.db.notification.create({
      data: {
        id: "old-assign",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: TASK_2,
        kind: "ASSIGNED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "assigned:old",
        createdAt: new Date(t0.getTime() - 30_000),
      },
    })
    // Within 2s clock-skew overlap before `since` -> included
    await fake.db.notification.create({
      data: {
        id: "overlap-assign",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: TASK_1,
        kind: "ASSIGNED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "assigned:overlap",
        createdAt: new Date(t0.getTime() - 1_000),
      },
    })
    // Status change & comment after `since` -> counted in bell count, excluded from live alerts
    await fake.db.notification.create({
      data: {
        id: "status-1",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: TASK_1,
        kind: "STATUS_CHANGED",
        actorType: "USER",
        actorId: ACTOR,
        payload: { from: "TODO", to: "IN_PROGRESS" },
        dedupeKey: "status:1",
        createdAt: new Date(t0.getTime() + 2_000),
      },
    })
    await fake.db.notification.create({
      data: {
        id: "comment-1",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: TASK_1,
        kind: "COMMENT_ADDED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "comment:1",
        createdAt: new Date(t0.getTime() + 3_000),
      },
    })
    // Deleted task assignment -> omitted from alerts so user never gets a "No longer available" toast
    await fake.db.notification.create({
      data: {
        id: "deleted-assign",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "TASK",
        subjectId: DELETED_TASK,
        kind: "ASSIGNED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "assigned:deleted",
        createdAt: new Date(t0.getTime() + 4_000),
      },
    })
    // Already-read mention -> omitted
    await fake.db.notification.create({
      data: {
        id: "read-mention",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "DOC",
        subjectId: DOC_1,
        kind: "MENTIONED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "mention:read",
        readAt: new Date(t0.getTime() + 6_000),
        createdAt: new Date(t0.getTime() + 5_000),
      },
    })
    // Unread mention after `since` -> included, ordered chronologically after overlap-assign
    await fake.db.notification.create({
      data: {
        id: "new-mention",
        workspaceId: WS,
        recipientUserId: ME,
        subjectType: "DOC",
        subjectId: DOC_1,
        kind: "MENTIONED",
        actorType: "USER",
        actorId: ACTOR,
        payload: {},
        dedupeKey: "mention:new",
        createdAt: new Date(t0.getTime() + 7_000),
      },
    })

    const res = await getUnread(
      new Request(`http://localhost/api/notifications/unread?${Q}&since=${encodeURIComponent(t0.toISOString())}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.available).toBe(true)
    expect(body.count).toBe(6)
    expect(body.overflow).toBe(false)
    expect(Number.isNaN(new Date(body.serverNow).getTime())).toBe(false)
    expect(body.alerts).toEqual([
      {
        id: "overlap-assign",
        kind: "ASSIGNED",
        sentence: "Ada Lovelace assigned this to you",
        subjectType: "TASK",
        subjectLabel: "Task",
        title: "Ship live notifications",
        path: `tasks/${TASK_1}`,
        createdAt: "2026-11-15T11:59:59.000Z",
      },
      {
        id: "new-mention",
        kind: "MENTIONED",
        sentence: "Ada Lovelace mentioned you in a comment",
        subjectType: "DOC",
        subjectLabel: "Doc",
        title: "Architecture ADR",
        path: `docs/${DOC_1}`,
        createdAt: "2026-11-15T12:00:07.000Z",
      },
    ])
  })
})
