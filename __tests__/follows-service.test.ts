import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig, getFollowable } from "@/lib/followable"
import { resetFollowingAvailabilityCache } from "@/lib/following-flag"
import { autoFollow, FollowError, followSubject, isFollowing, listFollowers, unfollowSubject } from "@/lib/follows"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const WS = "00000000-0000-4000-8000-000000000001"
const OTHER_WS = "00000000-0000-4000-8000-000000000002"
const USER = "00000000-0000-4000-8000-0000000000a1"
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2"
const TASK = "00000000-0000-4000-8000-0000000000b1"
const subject = { workspaceId: WS, subjectType: "TASK", subjectId: TASK }

let fake: ReturnType<typeof createFakeFollowDb>

beforeEach(() => {
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 3
  resetFollowingAvailabilityCache()
  fake = createFakeFollowDb()
  fake.member(WS, USER)
  fake.member(WS, OTHER_USER)
  vi.spyOn(getFollowable("TASK")!, "resolveWorkspace").mockImplementation(async (id) => (id === TASK ? { workspaceId: WS } : null))
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const rows = () => fake.tables.follow

describe("followSubject (manual)", () => {
  it("creates a FOLLOWING MANUAL row with app-set timestamps", async () => {
    const result = await followSubject({ userId: USER, ...subject }, fake.db)
    expect(result).toEqual({ status: "followed" })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ userId: USER, workspaceId: WS, subjectType: "TASK", subjectId: TASK, state: "FOLLOWING", source: "MANUAL" })
    expect(rows()[0].createdAt).toBeInstanceOf(Date)
    expect(rows()[0].updatedAt).toBeInstanceOf(Date)
  })

  it("is idempotent and leaves an existing auto follow's source alone", async () => {
    await autoFollow({ userId: USER, ...subject, source: "AUTO_COMMENT" }, fake.db)
    const result = await followSubject({ userId: USER, ...subject }, fake.db)
    expect(result).toEqual({ status: "already_following" })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("AUTO_COMMENT")
  })

  it("re-follows from a MUTED tombstone, because an explicit follow is the user's own choice", async () => {
    await unfollowSubject({ userId: USER, ...subject }, fake.db)
    const result = await followSubject({ userId: USER, ...subject }, fake.db)
    expect(result).toEqual({ status: "followed" })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ state: "FOLLOWING", source: "MANUAL" })
  })

  it("survives losing a create race by reading the winner's row", async () => {
    type Create = (args: { data: object }) => Promise<unknown>
    const delegate = fake.db.follow as unknown as { create: Create }
    const realCreate: Create = delegate.create.bind(delegate)
    let raced = false
    delegate.create = async (args) => {
      if (!raced) {
        raced = true
        await realCreate({ data: { ...args.data, source: "AUTO_CREATE" } })
      }
      return realCreate(args)
    }
    const result = await followSubject({ userId: USER, ...subject }, fake.db)
    expect(result).toEqual({ status: "already_following" })
    expect(rows()).toHaveLength(1)
  })
})

describe("unfollowSubject", () => {
  it("turns a FOLLOWING row into a MUTED tombstone without deleting it", async () => {
    await followSubject({ userId: USER, ...subject }, fake.db)
    const result = await unfollowSubject({ userId: USER, ...subject }, fake.db)
    expect(result).toEqual({ status: "unfollowed" })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].state).toBe("MUTED")
  })

  it("creates a tombstone when the user never followed, so auto-follow cannot add them later", async () => {
    await unfollowSubject({ userId: USER, ...subject }, fake.db)
    expect(rows()[0]).toMatchObject({ state: "MUTED", source: "MANUAL" })
    await autoFollow({ userId: USER, ...subject, source: "AUTO_COMMENT" }, fake.db)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].state).toBe("MUTED")
  })

  it("is idempotent", async () => {
    await unfollowSubject({ userId: USER, ...subject }, fake.db)
    const again = await unfollowSubject({ userId: USER, ...subject }, fake.db)
    expect(again).toEqual({ status: "already_muted" })
    expect(rows()).toHaveLength(1)
  })
})

describe("autoFollow", () => {
  it("inserts a FOLLOWING row with the auto source when absent", async () => {
    const result = await autoFollow({ userId: USER, ...subject, source: "AUTO_CREATE" }, fake.db)
    expect(result).toEqual({ status: "followed" })
    expect(rows()[0]).toMatchObject({ state: "FOLLOWING", source: "AUTO_CREATE" })
  })

  it("never overrides MUTED, including after the user's own comment (open question 7)", async () => {
    await unfollowSubject({ userId: USER, ...subject }, fake.db)
    for (const source of ["AUTO_CREATE", "AUTO_COMMENT", "AUTO_ASSIGN"] as const) {
      const result = await autoFollow({ userId: USER, ...subject, source }, fake.db)
      expect(result).toEqual({ status: "skipped", reason: "already_exists" })
    }
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ state: "MUTED", source: "MANUAL" })
  })

  it("does not rewrite an existing follow", async () => {
    await autoFollow({ userId: USER, ...subject, source: "AUTO_CREATE" }, fake.db)
    await autoFollow({ userId: USER, ...subject, source: "AUTO_ASSIGN" }, fake.db)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("AUTO_CREATE")
  })

  it("rejects MANUAL as an auto source", async () => {
    const result = await autoFollow({ userId: USER, ...subject, source: "MANUAL" as never }, fake.db)
    expect(result).toEqual({ status: "skipped", reason: "invalid_source" })
    expect(rows()).toHaveLength(0)
  })

  it("never throws: a failing write is swallowed and logged so the source mutation is unaffected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(fake.db.follow, "createMany").mockRejectedValue(new Error("db down"))
    await expect(autoFollow({ userId: USER, ...subject, source: "AUTO_CREATE" }, fake.db)).resolves.toEqual({ status: "skipped", reason: "error" })
    expect(log).toHaveBeenCalled()
  })

  it("skips silently for non-members, inactive types, missing subjects and the disabled flag", async () => {
    await expect(autoFollow({ userId: "stranger", ...subject, source: "AUTO_CREATE" }, fake.db)).resolves.toEqual({ status: "skipped", reason: "not_a_member" })
    await expect(autoFollow({ userId: USER, ...subject, subjectId: "missing", source: "AUTO_CREATE" }, fake.db)).resolves.toEqual({ status: "skipped", reason: "subject_not_found" })
    followableConfig.shippedSlice = 1
    await expect(autoFollow({ userId: USER, ...subject, source: "AUTO_CREATE" }, fake.db)).resolves.toEqual({ status: "skipped", reason: "inactive_subject_type" })
    followableConfig.shippedSlice = 3
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    await expect(autoFollow({ userId: USER, ...subject, source: "AUTO_CREATE" }, fake.db)).resolves.toEqual({ status: "skipped", reason: "disabled" })
    expect(rows()).toHaveLength(0)
  })
})

describe("validation of manual follows", () => {
  const code = async (promise: Promise<unknown>) => promise.then(() => null, (error: FollowError) => error.code)

  it("fails loudly when the feature is off", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    expect(await code(followSubject({ userId: USER, ...subject }, fake.db))).toBe("FOLLOWING_DISABLED")
  })

  it("rejects unknown and not-yet-shipped subject types", async () => {
    expect(await code(followSubject({ userId: USER, ...subject, subjectType: "PORTAL_ACCOUNT" }, fake.db))).toBe("UNKNOWN_SUBJECT_TYPE")
    followableConfig.shippedSlice = 1
    expect(await code(followSubject({ userId: USER, ...subject }, fake.db))).toBe("INACTIVE_SUBJECT_TYPE")
  })

  it("rejects a subject that does not exist", async () => {
    expect(await code(followSubject({ userId: USER, ...subject, subjectId: "nope" }, fake.db))).toBe("SUBJECT_NOT_FOUND")
  })

  it("rejects a subject that belongs to another workspace (the only integrity check without FKs)", async () => {
    fake.member(OTHER_WS, USER)
    expect(await code(followSubject({ userId: USER, ...subject, workspaceId: OTHER_WS }, fake.db))).toBe("SUBJECT_NOT_FOUND")
    expect(rows()).toHaveLength(0)
  })

  it("rejects a caller who is not a current workspace member, so agents and portal users cannot follow", async () => {
    expect(await code(followSubject({ userId: "an-agent-id", ...subject }, fake.db))).toBe("NOT_A_MEMBER")
    expect(rows()).toHaveLength(0)
  })
})

describe("isFollowing and listFollowers", () => {
  it("reports only FOLLOWING state as following", async () => {
    expect(await isFollowing(USER, "TASK", TASK, fake.db)).toBe(false)
    await followSubject({ userId: USER, ...subject }, fake.db)
    expect(await isFollowing(USER, "TASK", TASK, fake.db)).toBe(true)
    await unfollowSubject({ userId: USER, ...subject }, fake.db)
    expect(await isFollowing(USER, "TASK", TASK, fake.db)).toBe(false)
  })

  it("lists FOLLOWING users of the subject and omits tombstones", async () => {
    await followSubject({ userId: USER, ...subject }, fake.db)
    await unfollowSubject({ userId: OTHER_USER, ...subject }, fake.db)
    expect(await listFollowers("TASK", TASK, { prisma: fake.db })).toEqual([USER])
  })

  it("respects the limit", async () => {
    await followSubject({ userId: USER, ...subject }, fake.db)
    await followSubject({ userId: OTHER_USER, ...subject }, fake.db)
    expect(await listFollowers("TASK", TASK, { limit: 1, prisma: fake.db })).toHaveLength(1)
  })
})
