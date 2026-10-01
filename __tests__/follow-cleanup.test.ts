import { beforeEach, describe, expect, it } from "vitest"
import { vi } from "vitest"
import { deleteMemberFollowState, deleteSubjectFollowState, deleteWorkspaceNotifications } from "@/lib/follow-cleanup"
import type { AppPrismaClient } from "@/lib/db"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const WS = "00000000-0000-4000-8000-000000000001"
const OTHER_WS = "00000000-0000-4000-8000-000000000002"
const U1 = "00000000-0000-4000-8000-0000000000a1"
const U2 = "00000000-0000-4000-8000-0000000000a2"
const TASK = "00000000-0000-4000-8000-0000000000b1"
const OTHER_TASK = "00000000-0000-4000-8000-0000000000b2"

let fake: ReturnType<typeof createFakeFollowDb>
let serial = 0

const follow = (workspaceId: string, userId: string, subjectId: string, subjectType = "TASK") =>
  fake.tables.follow.push({ id: `f${serial++}`, workspaceId, userId, subjectType, subjectId, state: "FOLLOWING", source: "MANUAL" })
const notification = (workspaceId: string, recipientUserId: string, subjectId: string, subjectType = "TASK") =>
  fake.tables.notification.push({ id: `n${serial++}`, workspaceId, recipientUserId, subjectType, subjectId, kind: "STATUS_CHANGED", actorType: "USER", actorId: null, payload: {}, dedupeKey: `k${serial}`, readAt: null })

beforeEach(() => {
  fake = createFakeFollowDb()
  serial = 0
})

describe("deleteSubjectFollowState", () => {
  it("removes follows and notifications for the deleted subjects only", async () => {
    follow(WS, U1, TASK)
    follow(WS, U1, OTHER_TASK)
    follow(WS, U1, TASK, "DOC")
    notification(WS, U1, TASK)
    notification(WS, U1, OTHER_TASK)
    await deleteSubjectFollowState("TASK", [TASK], fake.db)
    expect(fake.tables.follow.map((f) => [f.subjectType, f.subjectId])).toEqual([["TASK", OTHER_TASK], ["DOC", TASK]])
    expect(fake.tables.notification.map((n) => n.subjectId)).toEqual([OTHER_TASK])
  })

  it("does nothing for an empty id list", async () => {
    follow(WS, U1, TASK)
    await deleteSubjectFollowState("TASK", [], fake.db)
    expect(fake.tables.follow).toHaveLength(1)
  })
})

describe("deleteMemberFollowState", () => {
  it("removes one member's rows for one workspace and nothing else", async () => {
    follow(WS, U1, TASK)
    follow(WS, U2, TASK)
    follow(OTHER_WS, U1, TASK)
    notification(WS, U1, TASK)
    notification(WS, U2, TASK)
    notification(OTHER_WS, U1, TASK)
    await deleteMemberFollowState(fake.db, WS, U1)
    expect(fake.tables.follow.map((f) => [f.workspaceId, f.userId])).toEqual([[WS, U2], [OTHER_WS, U1]])
    expect(fake.tables.notification.map((n) => [n.workspaceId, n.recipientUserId])).toEqual([[WS, U2], [OTHER_WS, U1]])
  })
})

describe("deleteWorkspaceNotifications", () => {
  it("removes every follow and notification in the workspace and leaves other workspaces alone", async () => {
    follow(WS, U1, TASK)
    follow(OTHER_WS, U1, OTHER_TASK)
    notification(WS, U2, TASK)
    notification(OTHER_WS, U2, OTHER_TASK)
    await deleteWorkspaceNotifications(fake.db, WS)
    expect(fake.tables.follow.map((f) => f.workspaceId)).toEqual([OTHER_WS])
    expect(fake.tables.notification.map((n) => n.workspaceId)).toEqual([OTHER_WS])
  })

  it("deletes in chunks that stay under the 3000-row transaction limit", async () => {
    for (let i = 0; i < 3500; i++) notification(WS, U1, TASK)
    const deleteMany = vi.spyOn(fake.db.notification, "deleteMany")
    await deleteWorkspaceNotifications(fake.db, WS)
    expect(fake.tables.notification).toHaveLength(0)
    expect(deleteMany.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const [args] of deleteMany.mock.calls) expect(((args as { where: { id: { in: string[] } } }).where.id.in).length).toBeLessThanOrEqual(1000)
  })

  it("tolerates the tables not existing yet, so a workspace delete works before the migration is applied", async () => {
    const missing = Object.assign(new Error("table does not exist"), { code: "P2021" })
    const prisma = {
      notification: { findMany: vi.fn().mockRejectedValue(missing), deleteMany: vi.fn() },
      follow: { findMany: vi.fn().mockRejectedValue(missing), deleteMany: vi.fn() },
    } as unknown as AppPrismaClient
    await expect(deleteWorkspaceNotifications(prisma, WS)).resolves.toBeUndefined()
    await expect(deleteMemberFollowState(prisma, WS, U1)).resolves.toBeUndefined()
    await expect(deleteSubjectFollowState("TASK", [TASK], prisma)).resolves.toBeUndefined()
  })

  it("does not swallow other database errors", async () => {
    const prisma = {
      notification: { findMany: vi.fn().mockRejectedValue(new Error("connection lost")), deleteMany: vi.fn() },
      follow: { findMany: vi.fn(), deleteMany: vi.fn() },
    } as unknown as AppPrismaClient
    await expect(deleteWorkspaceNotifications(prisma, WS)).rejects.toThrow("connection lost")
  })

  it("works with the feature flag off, because cleanup must survive a rollback", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    notification(WS, U1, TASK)
    await deleteWorkspaceNotifications(fake.db, WS)
    expect(fake.tables.notification).toHaveLength(0)
    vi.unstubAllEnvs()
  })
})
