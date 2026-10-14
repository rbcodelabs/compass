import getPrisma from "@/lib/db"
import { optionalCompassUrl, trustedCompassBaseUrl } from "@/lib/compass-url"
import { workspaceBasePath } from "@/lib/entity-links"
import { FollowError, followSubject, unfollowSubject, type FollowTarget } from "@/lib/follows"
import { followingAvailable } from "@/lib/following-flag"
import { getMcpActor } from "@/lib/mcp-authz"
import { fail, ok } from "@/lib/mcp-output"
import { listNotifications, markAllRead, markRead, unreadCount } from "@/lib/notifications"

/**
 * MCP tools for following and the notifications inbox (ADR "Following and
 * in-app notifications", section 2.8). Following belongs to a person: a Follow
 * row is a Compass user's subscription and a Notification is that user's inbox
 * entry. A tool call is therefore only valid when the credential resolves to one
 * user. An agent-scoped token acts as an Agent (ADR 0015), so it gets a clear
 * error instead of silently reading or editing the delegating human's inbox.
 * The tool gate already rejects agent identities (these tools are DENY in
 * AGENT_TOOL_POLICY); the check here is the second line, and also covers the
 * shared service key, which skips gating and has no user at all.
 */
const AGENT_ERROR = "Following and notifications belong to a person. Agent-scoped tokens cannot follow subjects or read or change an inbox; use a human identity."
const NO_USER_ERROR = "This credential is not tied to a user, so it has no follows or inbox. Use a user's own key or sign-in."

type Caller = { ok: true; userId: string } | { ok: false; error: string }

function callerUser(): Caller {
  const actor = getMcpActor()
  if (actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") return { ok: false, error: AGENT_ERROR }
  if ((actor.purpose && actor.purpose !== "USER") || !actor.userId) return { ok: false, error: NO_USER_ERROR }
  return { ok: true, userId: actor.userId }
}

type SubjectInput = { workspaceId: string; subjectType: string; subjectId: string }

async function runFollowChange(input: SubjectInput, change: typeof followSubject, verb: string) {
  const caller = callerUser()
  if (!caller.ok) return fail(caller.error)
  const target: FollowTarget = { userId: caller.userId, workspaceId: input.workspaceId, subjectType: input.subjectType, subjectId: input.subjectId }
  try {
    const result = await change(target)
    return ok(`**${verb}**\nSubject: ${input.subjectType} ${input.subjectId}\nResult: ${result.status}\nID: ${input.subjectId}`, {
      subjectType: input.subjectType, subjectId: input.subjectId, status: result.status,
    })
  } catch (error) {
    if (error instanceof FollowError) return fail(error.message, { code: error.code })
    throw error
  }
}

export const followTool = (input: SubjectInput) => runFollowChange(input, followSubject, "Following")
export const unfollowTool = (input: SubjectInput) => runFollowChange(input, unfollowSubject, "Unfollowed")

export async function listNotificationsTool(input: { workspaceId: string; limit?: number; cursor?: string; unreadOnly?: boolean }) {
  const caller = callerUser()
  if (!caller.ok) return fail(caller.error)
  const prisma = getPrisma()
  if (!(await followingAvailable(prisma))) return fail("Following is not enabled.")

  const [page, unread, workspace] = await Promise.all([
    listNotifications(caller.userId, input.workspaceId, { limit: input.limit ?? 25, cursor: input.cursor, unreadOnly: input.unreadOnly }),
    unreadCount(caller.userId, input.workspaceId),
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { slug: true, organization: { select: { slug: true } } } }),
  ])
  const base = workspace?.organization?.slug ? workspaceBasePath({ orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug }) : null
  const items = page.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    // Null when the subject was deleted or the caller can no longer see it.
    subjectTitle: item.subject?.title ?? null,
    subjectUrl: item.subject && base ? optionalCompassUrl(() => new URL(`${base}/${item.subject!.path}`, trustedCompassBaseUrl()).toString()) : null,
    actor: { type: item.actor.type, name: item.actor.name },
    payload: item.payload,
    read: item.read,
    createdAt: item.createdAt.toISOString(),
  }))
  return ok(`${items.length} notification${items.length === 1 ? "" : "s"} (${unread.count}${unread.overflow ? "+" : ""} unread in this workspace).`, {
    items, count: items.length, unreadCount: unread.count, unreadOverflow: unread.overflow, nextCursor: page.nextCursor,
  })
}

export async function markReadTool(input: { workspaceId: string; notificationIds?: string[]; all?: boolean }) {
  const caller = callerUser()
  if (!caller.ok) return fail(caller.error)
  const hasIds = Array.isArray(input.notificationIds) && input.notificationIds.length > 0
  if (hasIds === Boolean(input.all)) return fail("Pass exactly one of notificationIds or all: true.")
  const prisma = getPrisma()
  if (!(await followingAvailable(prisma))) return fail("Following is not enabled.")
  const marked = input.all
    ? (await markAllRead(caller.userId, input.workspaceId)).marked
    : await markRead(caller.userId, input.workspaceId, input.notificationIds!)
  return ok(`Marked ${marked} notification${marked === 1 ? "" : "s"} read.`, { marked })
}
