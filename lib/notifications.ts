import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { followingAvailable } from "@/lib/following-flag"
import { getFollowable, isSubjectTypeActive, passesTypeAccessRule, viewerIdsFor, type SubjectDisplay } from "@/lib/followable"
import { listFollowers } from "@/lib/follows"

/**
 * Notifications (ADR "Following and in-app notifications", sections 2.5 to 2.8).
 *
 * A Notification is a record that something happened to a subject a user
 * follows. It is not a system of record: it is written after the source
 * mutation has committed, best-effort, and never blocks or fails that mutation.
 * Fan-out is on write (one row per recipient), rows are never updated except
 * `readAt`, and inbox coalescing happens on read, so hot subjects do not produce
 * OCC conflicts on Aurora DSQL.
 *
 * Content is deliberately not stored. The payload holds machine facts only and
 * titles are resolved at read time behind an access check, so a recipient who
 * lost access, or a renamed or deleted subject, cannot leak stale content.
 */
export const NOTIFICATION_KINDS = ["STATUS_CHANGED", "COMMENT_ADDED", "COMMENT_REPLIED", "ASSIGNED"] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]
export const NOTIFICATION_ACTOR_TYPES = ["USER", "AGENT", "EXTERNAL", "SYSTEM"] as const
export type NotificationActorType = (typeof NOTIFICATION_ACTOR_TYPES)[number]

/** Guard rail on fan-out size; the ADR bets on workspace-bounded follower counts. */
export const MAX_RECIPIENTS_PER_EVENT = 500
/** The bell shows "99+" beyond this, so the unread query is bounded. */
export const UNREAD_DISPLAY_CAP = 99
/**
 * Read notifications older than this are pruned lazily on mark-all-read. Unread
 * ones are never pruned in v1. No scheduled sweep exists to hook into (ADR open
 * question 9), so this is the conservative retention: keep more, delete less.
 */
export const READ_RETENTION_DAYS = 90

const PAYLOAD_KEYS = ["from", "to", "commentId", "parentCommentId"] as const
const PAYLOAD_VALUE_MAX = 80
const DEDUPE_KEY_MAX = 200
const BATCH = 1000
const MAX_MARK_BATCHES = 20
const MAX_PRUNE_BATCHES = 5
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SubjectEvent = {
  workspaceId: string
  subjectType: string
  subjectId: string
  kind: NotificationKind
  /**
   * Who did it. `id` is the User or Agent id for USER and AGENT actors. For
   * EXTERNAL and SYSTEM actors it is ignored and stored as null: an external
   * author's identity is never put in a notification.
   */
  actor: { type: NotificationActorType; id: string | null }
  /** Machine facts only: from, to, commentId, parentCommentId. Anything else is dropped. */
  payload?: Partial<Record<(typeof PAYLOAD_KEYS)[number], string | null>>
  /** Unique per recipient. e.g. `comment:{commentId}` or `status:{subjectId}:{updateEventId}`. */
  dedupeKey: string
  /**
   * Users to leave out besides the actor, e.g. the person whose own MCP
   * credential an agent acted through, because they asked for the change.
   */
  excludeUserIds?: string[]
  /**
   * When set, only these users can receive the event (still intersected with
   * FOLLOWING followers, so a MUTED tombstone is respected, and still minus the
   * actor). ASSIGNED uses it so the assignee hears about the assignment without
   * every other follower of the Task being told who it went to.
   */
  recipientUserIds?: string[]
}

export type EmitResult =
  | { status: "emitted"; recipients: number; created: number }
  | { status: "skipped"; reason: "disabled" | "inactive_subject_type" | "kind_not_emitted" | "no_followers" | "no_recipients" }
  | { status: "failed" }

let emitFailures = 0
/** Emit failures since process start. The ADR's riskiest assumption is that lost events are tolerable; a non-zero count in practice means adopting an outbox. */
export const getEmitFailureCount = () => emitFailures
export const resetEmitFailureCount = () => { emitFailures = 0 }

function emitsKind(type: string, kind: NotificationKind): boolean {
  const def = getFollowable(type)
  if (!def) return false
  if (kind === "STATUS_CHANGED") return def.emitsStatus
  if (kind === "ASSIGNED") return def.emitsAssignment
  return def.emitsComments
}

function sanitizePayload(payload: SubjectEvent["payload"]): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const key of PAYLOAD_KEYS) {
    const value = payload?.[key]
    if (typeof value === "string" && value.length > 0) clean[key] = value.slice(0, PAYLOAD_VALUE_MAX)
  }
  return clean
}

function validateEvent(event: SubjectEvent): void {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(event.kind)) throw new Error(`Unknown notification kind ${event.kind}`)
  if (!(NOTIFICATION_ACTOR_TYPES as readonly string[]).includes(event.actor.type)) throw new Error(`Unknown actor type ${event.actor.type}`)
  if (!event.dedupeKey || event.dedupeKey.length > DEDUPE_KEY_MAX) throw new Error("dedupeKey must be 1 to 200 characters")
  if ((event.actor.type === "USER" || event.actor.type === "AGENT") && (!event.actor.id || !UUID.test(event.actor.id))) {
    throw new Error("USER and AGENT actors need a uuid id")
  }
}

/**
 * Fan an event out to the subject's followers. Call it AFTER the source mutation
 * has committed and outside any transaction. It never throws: any failure is
 * logged, counted and reported as `{ status: "failed" }`, so a notification
 * problem can never fail a user's real edit. Takes a self-contained event so a
 * queue or worker could call it later without changing any call site.
 *
 * Recipients are the subject's FOLLOWING followers minus the actor's own user and
 * `excludeUserIds`, intersected with current workspace members who pass the
 * type's access rule. One row per recipient; `skipDuplicates` on the unique
 * (recipient, dedupeKey) index makes a replay harmless.
 */
export async function emitSubjectEvent(event: SubjectEvent, prisma: AppPrismaClient = getPrisma()): Promise<EmitResult> {
  try {
    if (!(await followingAvailable(prisma))) return { status: "skipped", reason: "disabled" }
    validateEvent(event)
    if (!isSubjectTypeActive(event.subjectType)) return { status: "skipped", reason: "inactive_subject_type" }
    if (!emitsKind(event.subjectType, event.kind)) return { status: "skipped", reason: "kind_not_emitted" }

    const followers = await listFollowers(event.subjectType, event.subjectId, { limit: MAX_RECIPIENTS_PER_EVENT + 1, prisma })
    if (followers.length === 0) return { status: "skipped", reason: "no_followers" }
    if (followers.length > MAX_RECIPIENTS_PER_EVENT) {
      console.warn(`[notifications] ${event.subjectType} ${event.subjectId} has more than ${MAX_RECIPIENTS_PER_EVENT} followers; fan-out truncated`)
    }

    const excluded = new Set(event.excludeUserIds ?? [])
    if (event.actor.type === "USER" && event.actor.id) excluded.add(event.actor.id)
    const only = event.recipientUserIds ? new Set(event.recipientUserIds) : null
    const candidates = followers.slice(0, MAX_RECIPIENTS_PER_EVENT).filter((id) => !excluded.has(id) && (!only || only.has(id)))
    const recipients = await viewerIdsFor(event.subjectType, event.workspaceId, candidates, prisma)
    if (recipients.length === 0) return { status: "skipped", reason: "no_recipients" }

    const actorId = event.actor.type === "USER" || event.actor.type === "AGENT" ? event.actor.id : null
    const payload = sanitizePayload(event.payload)
    const { count } = await prisma.notification.createMany({
      data: recipients.map((recipientUserId) => ({
        workspaceId: event.workspaceId,
        recipientUserId,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        kind: event.kind,
        actorType: event.actor.type,
        actorId,
        payload,
        dedupeKey: event.dedupeKey,
      })),
      skipDuplicates: true,
    })
    return { status: "emitted", recipients: recipients.length, created: count }
  } catch (error) {
    emitFailures++
    console.error("[notifications] emit failed", { subjectType: event.subjectType, subjectId: event.subjectId, kind: event.kind }, error)
    return { status: "failed" }
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export type NotificationItem = {
  id: string
  kind: string
  subjectType: string
  subjectId: string
  actor: { type: string; id: string | null; name: string }
  payload: Record<string, string>
  read: boolean
  readAt: Date | null
  createdAt: Date
  /** Null when the subject is deleted or outside this workspace: render "no longer available". */
  subject: SubjectDisplay | null
}

export type NotificationGroup = {
  subjectType: string
  subjectId: string
  subject: SubjectDisplay | null
  unreadCount: number
  latestAt: Date
  items: NotificationItem[]
}

export type NotificationPage = {
  items: NotificationItem[]
  /** The page's items grouped per subject, newest group first (coalesce on read; stored rows are untouched). */
  groups: NotificationGroup[]
  nextCursor: string | null
}

const EMPTY_PAGE: NotificationPage = { items: [], groups: [], nextCursor: null }

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url")
function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|")
  const createdAt = new Date(iso)
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null
}

async function isCurrentMember(prisma: AppPrismaClient, workspaceId: string, userId: string): Promise<boolean> {
  return Boolean(await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } }))
}

const fallbackActorName = (type: string) =>
  type === "AGENT" ? "An agent" : type === "USER" ? "A teammate" : type === "EXTERNAL" ? "Someone outside your team" : "Compass"

/**
 * The caller's inbox for one workspace, newest first, cursor-paginated. Read time
 * is authoritative for access: it requires a current WorkspaceMember, re-checks
 * each subject type's own rule, and resolves display data in one batched query
 * per subject type present, so a stale row for a revoked user exposes nothing.
 */
export async function listNotifications(
  userId: string,
  workspaceId: string,
  options: { limit?: number; cursor?: string; prisma?: AppPrismaClient } = {},
): Promise<NotificationPage> {
  const prisma = options.prisma ?? getPrisma()
  if (!(await followingAvailable(prisma))) return EMPTY_PAGE
  if (!(await isCurrentMember(prisma, workspaceId, userId))) return EMPTY_PAGE

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const cursor = decodeCursor(options.cursor)
  const rows = await prisma.notification.findMany({
    where: {
      recipientUserId: userId,
      workspaceId,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null

  const idsByType = new Map<string, Set<string>>()
  for (const row of page) idsByType.set(row.subjectType, (idsByType.get(row.subjectType) ?? new Set()).add(row.subjectId))
  const displays = new Map<string, Map<string, SubjectDisplay>>()
  const visibleTypes = new Set<string>()
  for (const [type, ids] of idsByType) {
    const def = getFollowable(type)
    if (!def || !(await passesTypeAccessRule(type, userId, workspaceId))) continue
    visibleTypes.add(type)
    displays.set(type, await def.resolveDisplay(workspaceId, [...ids], prisma))
  }

  const visible = page.filter((row) => visibleTypes.has(row.subjectType))
  const userIds = [...new Set(visible.filter((r) => r.actorType === "USER" && r.actorId).map((r) => r.actorId!))]
  const agentIds = [...new Set(visible.filter((r) => r.actorType === "AGENT" && r.actorId).map((r) => r.actorId!))]
  const [users, agents] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [],
  ])
  const names = new Map<string, string | null>([...users, ...agents].map((entry) => [entry.id, entry.name]))

  const items: NotificationItem[] = visible.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    actor: { type: row.actorType, id: row.actorId, name: (row.actorId && names.get(row.actorId)) || fallbackActorName(row.actorType) },
    payload: row.payload as Record<string, string>,
    read: row.readAt !== null,
    readAt: row.readAt,
    createdAt: row.createdAt,
    subject: displays.get(row.subjectType)?.get(row.subjectId) ?? null,
  }))

  const groups = new Map<string, NotificationGroup>()
  for (const item of items) {
    const key = `${item.subjectType}:${item.subjectId}`
    const group = groups.get(key) ?? { subjectType: item.subjectType, subjectId: item.subjectId, subject: item.subject, unreadCount: 0, latestAt: item.createdAt, items: [] }
    group.items.push(item)
    if (!item.read) group.unreadCount++
    groups.set(key, group)
  }
  return { items, groups: [...groups.values()], nextCursor }
}

/** Unread count for the bell, bounded at 99 so the query never scans an unbounded backlog. */
export async function unreadCount(userId: string, workspaceId: string, prisma: AppPrismaClient = getPrisma()): Promise<{ count: number; overflow: boolean }> {
  const none = { count: 0, overflow: false }
  if (!(await followingAvailable(prisma))) return none
  if (!(await isCurrentMember(prisma, workspaceId, userId))) return none
  const rows = await prisma.notification.findMany({
    where: { recipientUserId: userId, workspaceId, readAt: null },
    select: { id: true },
    take: UNREAD_DISPLAY_CAP + 1,
  })
  return { count: Math.min(rows.length, UNREAD_DISPLAY_CAP), overflow: rows.length > UNREAD_DISPLAY_CAP }
}

/** Marks the caller's own unread notifications read. Other users' rows are never touched. */
export async function markRead(userId: string, workspaceId: string, ids: string[], prisma: AppPrismaClient = getPrisma()): Promise<number> {
  if (ids.length === 0 || !(await followingAvailable(prisma))) return 0
  const readAt = new Date()
  let marked = 0
  for (let i = 0; i < ids.length; i += BATCH) {
    const { count } = await prisma.notification.updateMany({
      where: { id: { in: ids.slice(i, i + BATCH) }, recipientUserId: userId, workspaceId, readAt: null },
      data: { readAt },
    })
    marked += count
  }
  return marked
}

/**
 * Marks everything up to `before` read (default: now), so notifications that
 * arrived after the user loaded the list stay unread. Batched under the row
 * limit. Also the lazy retention sweep: read rows older than
 * READ_RETENTION_DAYS are deleted first, judged by their state before this call.
 */
export async function markAllRead(
  userId: string,
  workspaceId: string,
  options: { before?: Date; now?: Date; prisma?: AppPrismaClient } = {},
): Promise<{ marked: number; pruned: number }> {
  const prisma = options.prisma ?? getPrisma()
  if (!(await followingAvailable(prisma))) return { marked: 0, pruned: 0 }
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - READ_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  let pruned = 0
  for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch++) {
    const stale = await prisma.notification.findMany({
      where: { recipientUserId: userId, workspaceId, readAt: { not: null }, createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    })
    if (stale.length === 0) break
    await prisma.notification.deleteMany({ where: { id: { in: stale.map((row) => row.id) }, recipientUserId: userId } })
    pruned += stale.length
    if (stale.length < BATCH) break
  }

  let marked = 0
  for (let batch = 0; batch < MAX_MARK_BATCHES; batch++) {
    const unread = await prisma.notification.findMany({
      where: { recipientUserId: userId, workspaceId, readAt: null, createdAt: { lte: options.before ?? now } },
      select: { id: true },
      take: BATCH,
    })
    if (unread.length === 0) break
    await prisma.notification.updateMany({ where: { id: { in: unread.map((row) => row.id) }, recipientUserId: userId, readAt: null }, data: { readAt: now } })
    marked += unread.length
    if (unread.length < BATCH) break
  }
  return { marked, pruned }
}
