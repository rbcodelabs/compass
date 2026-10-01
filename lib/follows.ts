import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { followingAvailable } from "@/lib/following-flag"
import { getFollowable, isSubjectTypeActive } from "@/lib/followable"

/**
 * Follow service (ADR section 2.8). A Follow is one user's subscription to one
 * subject. `state` is FOLLOWING or MUTED; unfollow keeps the row as a MUTED
 * tombstone so that auto-follow (create, comment, assign) never silently
 * re-follows someone who opted out. Only an explicit manual follow clears it.
 *
 * `userId` is always a Compass User with a current WorkspaceMember row. Agents,
 * portal accounts and embed visitors are never followers; membership is the
 * enforcement, since the schema has no foreign keys to do it.
 */
export type FollowState = "FOLLOWING" | "MUTED"
export type FollowSource = "MANUAL" | "AUTO_CREATE" | "AUTO_COMMENT" | "AUTO_ASSIGN"
export type AutoFollowSource = Exclude<FollowSource, "MANUAL">
const AUTO_SOURCES: readonly string[] = ["AUTO_CREATE", "AUTO_COMMENT", "AUTO_ASSIGN"]

export type FollowErrorCode =
  | "FOLLOWING_DISABLED"
  | "UNKNOWN_SUBJECT_TYPE"
  | "INACTIVE_SUBJECT_TYPE"
  | "SUBJECT_NOT_FOUND"
  | "NOT_A_MEMBER"

export class FollowError extends Error {
  constructor(readonly code: FollowErrorCode, message: string) {
    super(message)
    this.name = "FollowError"
  }
}

export type FollowTarget = {
  userId: string
  workspaceId: string
  subjectType: string
  subjectId: string
}

export type FollowResult =
  | { status: "followed" }
  | { status: "already_following" }
  | { status: "unfollowed" }
  | { status: "already_muted" }

export type AutoFollowResult =
  | { status: "followed" }
  | { status: "skipped"; reason: "already_exists" | "invalid_source" | "error" | Lowercase<Exclude<FollowErrorCode, "FOLLOWING_DISABLED">> | "disabled" }

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002"

/**
 * The write-time integrity checks, the only ones available without foreign keys:
 * feature available, type known and shipped, subject exists in this workspace,
 * and the user is a current member. A subject in another workspace is reported
 * as not found so existence never leaks across workspaces.
 */
async function assertFollowable(target: FollowTarget, prisma: AppPrismaClient): Promise<void> {
  if (!(await followingAvailable(prisma))) throw new FollowError("FOLLOWING_DISABLED", "Following is not enabled.")
  const def = getFollowable(target.subjectType)
  if (!def) throw new FollowError("UNKNOWN_SUBJECT_TYPE", `${target.subjectType} cannot be followed.`)
  if (!isSubjectTypeActive(target.subjectType)) throw new FollowError("INACTIVE_SUBJECT_TYPE", `${target.subjectType} cannot be followed yet.`)
  const subject = await def.resolveWorkspace(target.subjectId)
  if (!subject || subject.workspaceId !== target.workspaceId) throw new FollowError("SUBJECT_NOT_FOUND", `${target.subjectType} not found.`)
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: target.workspaceId, userId: target.userId }, select: { id: true } })
  if (!member) throw new FollowError("NOT_A_MEMBER", "Only workspace members can follow.")
}

const keyOf = (target: FollowTarget) => ({
  userId_subjectType_subjectId: { userId: target.userId, subjectType: target.subjectType, subjectId: target.subjectId },
})

/** Explicit Follow button. Clears a MUTED tombstone, because this is the user's own choice. */
export async function followSubject(target: FollowTarget, prisma: AppPrismaClient = getPrisma()): Promise<FollowResult> {
  await assertFollowable(target, prisma)
  const existing = await prisma.follow.findUnique({ where: keyOf(target), select: { id: true, state: true } })
  if (existing?.state === "FOLLOWING") return { status: "already_following" }
  if (existing) {
    await prisma.follow.update({ where: { id: existing.id }, data: { state: "FOLLOWING", source: "MANUAL", updatedAt: new Date() } })
    return { status: "followed" }
  }
  try {
    await prisma.follow.create({
      data: { workspaceId: target.workspaceId, userId: target.userId, subjectType: target.subjectType, subjectId: target.subjectId, state: "FOLLOWING", source: "MANUAL", updatedAt: new Date() },
    })
    return { status: "followed" }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // Lost a create race (two tabs, or an auto-follow in flight): the winner's row stands.
    const winner = await prisma.follow.findUnique({ where: keyOf(target), select: { id: true, state: true } })
    if (winner?.state === "MUTED") {
      await prisma.follow.update({ where: { id: winner.id }, data: { state: "FOLLOWING", source: "MANUAL", updatedAt: new Date() } })
      return { status: "followed" }
    }
    return { status: "already_following" }
  }
}

/** Unfollow keeps a MUTED tombstone, creating one when the user never followed. */
export async function unfollowSubject(target: FollowTarget, prisma: AppPrismaClient = getPrisma()): Promise<FollowResult> {
  await assertFollowable(target, prisma)
  const existing = await prisma.follow.findUnique({ where: keyOf(target), select: { id: true, state: true } })
  if (existing?.state === "MUTED") return { status: "already_muted" }
  if (existing) {
    await prisma.follow.update({ where: { id: existing.id }, data: { state: "MUTED", updatedAt: new Date() } })
    return { status: "unfollowed" }
  }
  try {
    await prisma.follow.create({
      data: { workspaceId: target.workspaceId, userId: target.userId, subjectType: target.subjectType, subjectId: target.subjectId, state: "MUTED", source: "MANUAL", updatedAt: new Date() },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const winner = await prisma.follow.findUnique({ where: keyOf(target), select: { id: true, state: true } })
    if (winner?.state === "FOLLOWING") await prisma.follow.update({ where: { id: winner.id }, data: { state: "MUTED", updatedAt: new Date() } })
  }
  return { status: "unfollowed" }
}

/**
 * Follow on create, comment or assign. Insert-if-absent only: an existing row of
 * any state, MUTED included, is never touched. Best-effort by contract. It runs
 * after the source mutation has committed, so it never throws; every failure is
 * logged and reported as a skip.
 */
export async function autoFollow(
  input: FollowTarget & { source: AutoFollowSource },
  prisma: AppPrismaClient = getPrisma(),
): Promise<AutoFollowResult> {
  if (!AUTO_SOURCES.includes(input.source)) return { status: "skipped", reason: "invalid_source" }
  try {
    await assertFollowable(input, prisma)
    const { count } = await prisma.follow.createMany({
      data: [{ workspaceId: input.workspaceId, userId: input.userId, subjectType: input.subjectType, subjectId: input.subjectId, state: "FOLLOWING", source: input.source, updatedAt: new Date() }],
      skipDuplicates: true,
    })
    return count === 1 ? { status: "followed" } : { status: "skipped", reason: "already_exists" }
  } catch (error) {
    if (error instanceof FollowError) {
      return { status: "skipped", reason: error.code === "FOLLOWING_DISABLED" ? "disabled" : (error.code.toLowerCase() as Lowercase<Exclude<FollowErrorCode, "FOLLOWING_DISABLED">>) }
    }
    console.error("[follows] auto-follow failed", error)
    return { status: "skipped", reason: "error" }
  }
}

export async function isFollowing(userId: string, subjectType: string, subjectId: string, prisma: AppPrismaClient = getPrisma()): Promise<boolean> {
  const row = await prisma.follow.findUnique({ where: { userId_subjectType_subjectId: { userId, subjectType, subjectId } }, select: { state: true } })
  return row?.state === "FOLLOWING"
}

/** User ids currently following the subject (FOLLOWING only; tombstones excluded). */
export async function listFollowers(
  subjectType: string,
  subjectId: string,
  options: { limit?: number; prisma?: AppPrismaClient } = {},
): Promise<string[]> {
  const prisma = options.prisma ?? getPrisma()
  const rows = await prisma.follow.findMany({
    where: { subjectType, subjectId, state: "FOLLOWING" },
    select: { userId: true },
    take: options.limit,
    orderBy: { createdAt: "asc" },
  })
  return rows.map((row) => row.userId)
}
