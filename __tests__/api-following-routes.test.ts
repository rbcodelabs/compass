import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig, getFollowable } from "@/lib/followable"
import { resetFollowingAvailabilityCache } from "@/lib/following-flag"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => holder.db }))

import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { GET as getFollowing, PUT as putFollowing } from "@/app/api/following/route"
import { GET as getUnread } from "@/app/api/notifications/unread/route"
import { POST as postRead } from "@/app/api/notifications/read/route"

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const OTHER = "00000000-0000-4000-8000-0000000000a2"
const TASK = "00000000-0000-4000-8000-0000000000b1"
const Q = "orgSlug=acme&workspaceSlug=ws"

let fake: ReturnType<typeof createFakeFollowDb>
const signedIn = (id: string | null) => vi.mocked(auth).mockResolvedValue((id ? { user: { id } } : null) as never)
const member = (is: boolean) => vi.mocked(getWorkspace).mockResolvedValue((is ? { id: WS } : null) as never)
const get = (path: string, handler: typeof getFollowing) => handler(new Request(`http://localhost${path}`))
const send = (path: string, handler: typeof putFollowing, body: unknown, method = "PUT") => handler(new Request(`http://localhost${path}`, { method, body: JSON.stringify(body) }))

beforeEach(() => {
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 2
  resetFollowingAvailabilityCache()
  fake = createFakeFollowDb()
  holder.db = fake.db
  fake.member(WS, ME)
  fake.member(WS, OTHER)
  signedIn(ME)
  member(true)
  vi.spyOn(getFollowable("TASK")!, "resolveWorkspace").mockImplementation(async (id) => (id === TASK ? { workspaceId: WS } : null))
  vi.spyOn(getFollowable("TASK")!, "resolveDisplay").mockImplementation(async (_ws, ids) => new Map(ids.map((id) => [id, { title: "Ship it", path: `tasks/${id}` }])))
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("GET /api/following", () => {
  const url = `/api/following?${Q}&subjectType=TASK&subjectId=${TASK}`

  it("reports the caller's own state", async () => {
    expect(await (await get(url, getFollowing)).json()).toEqual({ available: true, following: false, muted: false })
    await send("/api/following", putFollowing, { orgSlug: "acme", workspaceSlug: "ws", subjectType: "TASK", subjectId: TASK, following: true })
    expect(await (await get(url, getFollowing)).json()).toEqual({ available: true, following: true, muted: false })
    await send("/api/following", putFollowing, { orgSlug: "acme", workspaceSlug: "ws", subjectType: "TASK", subjectId: TASK, following: false })
    expect(await (await get(url, getFollowing)).json()).toEqual({ available: true, following: false, muted: true })
  })

  it("is available:false (not an error) when the flag is off or the subject type has not shipped", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect(await (await get(url, getFollowing)).json()).toEqual({ available: false })
    vi.stubEnv("FOLLOWING_ENABLED", "1")
    followableConfig.shippedSlice = 1
    expect(await (await get(url, getFollowing)).json()).toEqual({ available: false })
  })

  it("401s without a session and 404s for a non-member, never reading the subject", async () => {
    signedIn(null)
    expect((await get(url, getFollowing)).status).toBe(401)
    signedIn(ME)
    member(false)
    expect((await get(url, getFollowing)).status).toBe(404)
  })

  it("400s on missing parameters and 404s for a subject outside the workspace", async () => {
    expect((await get(`/api/following?${Q}`, getFollowing)).status).toBe(400)
    expect((await get(`/api/following?${Q}&subjectType=TASK&subjectId=00000000-0000-4000-8000-0000000000ff`, getFollowing)).status).toBe(404)
  })
})

describe("PUT /api/following", () => {
  const body = { orgSlug: "acme", workspaceSlug: "ws", subjectType: "TASK", subjectId: TASK }

  it("follows and unfollows for the signed-in user only", async () => {
    const on = await send("/api/following", putFollowing, { ...body, following: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ available: true, following: true, muted: false })
    expect(fake.tables.follow).toMatchObject([{ userId: ME, state: "FOLLOWING", source: "MANUAL" }])
    const off = await send("/api/following", putFollowing, { ...body, following: false })
    expect(await off.json()).toEqual({ available: true, following: false, muted: true })
    expect(fake.tables.follow).toMatchObject([{ userId: ME, state: "MUTED" }])
  })

  it("rejects bad bodies, anonymous callers and non-members", async () => {
    expect((await send("/api/following", putFollowing, { ...body })).status).toBe(400)
    expect((await send("/api/following", putFollowing, { ...body, following: "yes" })).status).toBe(400)
    expect((await putFollowing(new Request("http://localhost/api/following", { method: "PUT", body: "not json" }))).status).toBe(400)
    signedIn(null)
    expect((await send("/api/following", putFollowing, { ...body, following: true })).status).toBe(401)
    signedIn(ME)
    member(false)
    expect((await send("/api/following", putFollowing, { ...body, following: true })).status).toBe(404)
    expect(fake.tables.follow).toHaveLength(0)
  })

  it("maps service refusals to a status instead of a 500", async () => {
    followableConfig.shippedSlice = 1
    expect((await send("/api/following", putFollowing, { ...body, following: true })).status).toBe(404)
    followableConfig.shippedSlice = 2
    expect((await send("/api/following", putFollowing, { ...body, subjectType: "NOPE", following: true })).status).toBe(400)
    expect((await send("/api/following", putFollowing, { ...body, subjectId: "00000000-0000-4000-8000-0000000000ff", following: true })).status).toBe(404)
  })
})

describe("notifications bell routes", () => {
  const seed = (n: number, recipient = ME, extra: Record<string, unknown> = {}) =>
    fake.db.notification.create({ data: { workspaceId: WS, recipientUserId: recipient, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actorType: "USER", actorId: OTHER, payload: {}, dedupeKey: `k${n}${recipient}`, createdAt: new Date(2026, 0, 1, 0, n), ...extra } })

  it("GET unread returns the caller's own bounded count, never someone else's", async () => {
    await seed(1)
    await seed(2)
    await seed(3, OTHER)
    expect(await (await get(`/api/notifications/unread?${Q}`, getUnread)).json()).toEqual({ available: true, count: 2, overflow: false })
  })

  it("GET unread is available:false when following is off, and count 0 for a non-member", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect(await (await get(`/api/notifications/unread?${Q}`, getUnread)).json()).toEqual({ available: false, count: 0, overflow: false })
    vi.stubEnv("FOLLOWING_ENABLED", "1")
    member(false)
    expect((await get(`/api/notifications/unread?${Q}`, getUnread)).status).toBe(404)
    signedIn(null)
    expect((await get(`/api/notifications/unread?${Q}`, getUnread)).status).toBe(401)
  })

  it("POST read marks the given ids or everything, only for the caller", async () => {
    const mine = await seed(1) as { id: string }
    await seed(2)
    const theirs = await seed(3, OTHER) as { id: string }
    const some = await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws", ids: [mine.id, theirs.id] }, "POST")
    expect(await some.json()).toEqual({ marked: 1 })
    expect(fake.tables.notification.find((n) => n.id === theirs.id)?.readAt).toBeNull()
    const all = await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws", all: true }, "POST")
    expect(await all.json()).toEqual({ marked: 1 })
  })

  it("POST read validates its body and requires a session and membership", async () => {
    expect((await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws" }, "POST")).status).toBe(400)
    expect((await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws", ids: ["x"], all: true }, "POST")).status).toBe(400)
    signedIn(null)
    expect((await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws", all: true }, "POST")).status).toBe(401)
    signedIn(ME)
    member(false)
    expect((await send("/api/notifications/read", postRead, { orgSlug: "acme", workspaceSlug: "ws", all: true }, "POST")).status).toBe(404)
  })
})
