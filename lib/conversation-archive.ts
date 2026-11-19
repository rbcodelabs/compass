/**
 * Archive and restore for shared conversations (TASK-195 S2).
 *
 * THERE IS NO HARD DELETE IN THE NEW CONVERSATION MODEL (Rick, 2026-11-19: "archive everywhere"). The only code that ever
 * removes mirrored content is S0's pure-mirror purge for LEGACY comment deletes, and nothing here calls it. Archive stamps
 * `archivedAt` and nothing else: every message, run, link and participant row is left exactly as it was, so a restored
 * thread comes back complete.
 *
 * Consequence, deliberately: there is no way to remove a single message. Per-message removal was part of the retired
 * delete design and is NOT offered; an author can still edit their own words (S1), and an admin can archive the whole
 * thread. If someone needs a message gone for legal reasons, that is a separate, audited, operator-run action.
 *
 * Who may archive or restore a shared (WORKSPACE) thread: the thread starter (author of its first message, falling
 * back to the conversation owner for rows that predate author tracking; a comment-origin thread whose author is
 * unknown has NO starter, because its conversation owner is only a placeholder member, so only an admin may act), a workspace admin, or an organization
 * owner/admin WHO IS ALSO A WORKSPACE MEMBER: every read goes through `accessibleConversationsWhere`, which requires
 * workspace membership, so an org owner outside the workspace gets 404 (covered by the real-database tests). The same rule is used to decide who is shown an archived thread in the "Show archived" list, so a
 * person who cannot restore it never learns its title or summary. A conversation the caller cannot see is a 404
 * (never 403, see lib/agent-conversation-access.ts); a member who can see it without the right gets a 403.
 *
 * Privacy: archiving does not redact. Reads (`accessibleConversationsWhere`) deliberately carry no `archivedAt`
 * clause, so an archived thread stays readable by exactly the people who could read it before, by id.
 *
 * Private chats keep their older rule (owner-only, see setAgentConversationArchived) and are not audited here.
 *
 * `updatedAt`: Prisma's updatedAt write extension stamps `now` on any update that omits it. Archive and restore carry
 * the conversation's own value through unchanged (re-read inside the transaction and written compare-and-set, see
 * stampConversationArchived), for shared and private conversations alike, so neither action reorders a list and a
 * message that lands mid-archive is never reverted.
 *
 * Read-only while archived ("archived takes no replies"): the turn route answers 404 with `x-conversation-state:
 * archived`, edits answer 409 and `canEdit` is false, invites and settings changes answer 409, continuation runs
 * (wake-ups, supervision actions) are refused with CONVERSATION_ARCHIVED, and archiving cancels pending wake-ups in the
 * same transaction. A run that is ALREADY in flight when the thread is archived is allowed to finish and may append its
 * reply: interrupting a run mid-stream is a separate decision. Restoring re-enables everything except cancelled wake-ups.
 *
 * Each real change writes a content-free AgentAuditLog row in the same transaction (ids, role, count; never text).
 * `conversationId` on that row is null on purpose: the audit must survive anything that later sweeps a conversation's
 * own audit rows, and S0's mirror-purge treats a conversation that still has audit rows as "has content".
 */

import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { effectiveAuthorId, isWorkspaceAdmin } from "@/lib/conversation-messages"
import { withConflictRetry } from "@/lib/transaction-conflict"
import { stampConversationArchived } from "@/lib/agent-conversations"
import { cancelAllPendingConversationWakeups } from "@/lib/agent-scheduled-wakeups"

export type ArchiveResult =
  | { ok: true; archived: boolean; changed: boolean }
  | { ok: false; status: 403 | 404 }

/** Pure policy: may this user archive or restore a thread started by `rootAuthorId`? */
export function canArchiveConversation(input: { rootAuthorId: string | null; userId: string; isAdmin: boolean }): boolean {
  return (input.rootAuthorId !== null && input.rootAuthorId === input.userId) || input.isAdmin
}

/** The thread starter: whoever wrote its first message, else the conversation owner; null when nobody can be named (see effectiveAuthorId). */
async function rootAuthorOf(
  prisma: Pick<AppPrismaClient, "agentMessage">,
  conversationId: string,
  ownerUserId: string,
): Promise<string | null> {
  const first = await prisma.agentMessage.findFirst({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { authorUserId: true, messageKind: true },
  })
  return first ? effectiveAuthorId({ authorUserId: first.authorUserId ?? null, messageKind: first.messageKind ?? null }, ownerUserId) : ownerUserId
}

export type ArchiveCapabilities = { archived: boolean; canArchive: boolean; canRestore: boolean }

/**
 * What the caller may do with this SHARED conversation, computed on the server and handed to the client; the client
 * never infers it, because admins are not visible to it. An archived thread offers restore only, a live one archive only.
 * All false for private chats, interview conversations and anything the caller cannot see.
 */
export async function archiveCapabilities(input: {
  conversationId: string
  workspaceId: string
  userId: string
}): Promise<ArchiveCapabilities> {
  const { conversationId, workspaceId, userId } = input
  const prisma = getPrisma()
  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { userId: true, visibility: true, interviewProcessingJson: true, archivedAt: true },
  })
  if (!conversation) return { archived: false, canArchive: false, canRestore: false }
  const archived = conversation.archivedAt != null
  if (conversation.visibility !== "WORKSPACE" || conversation.interviewProcessingJson != null) {
    return { archived, canArchive: false, canRestore: false }
  }
  const rootAuthorId = await rootAuthorOf(prisma, conversationId, conversation.userId)
  const isAdmin = rootAuthorId === userId ? false : await isWorkspaceAdmin(prisma, workspaceId, userId)
  const allowed = canArchiveConversation({ rootAuthorId, userId, isAdmin })
  return { archived, canArchive: allowed && !archived, canRestore: allowed && archived }
}

export async function setConversationArchived(input: {
  conversationId: string
  workspaceId: string
  userId: string
  archived: boolean
}): Promise<ArchiveResult> {
  const { conversationId, workspaceId, userId, archived } = input
  const prisma = getPrisma()

  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { userId: true, visibility: true, interviewProcessingJson: true, targetType: true, targetId: true },
  })
  if (!conversation) return { ok: false, status: 404 }

  // Private chats and interview conversations: unchanged owner-only behaviour, 404 for everyone else.
  if (conversation.visibility !== "WORKSPACE" || conversation.interviewProcessingJson != null) {
    if (conversation.userId !== userId) return { ok: false, status: 404 }
    const changedPrivate = await withConflictRetry(() => prisma.$transaction((tx) => stampConversationArchived(tx, { conversationId, workspaceId, archived })))
    return { ok: true, archived, changed: changedPrivate }
  }

  const rootAuthorId = await rootAuthorOf(prisma, conversationId, conversation.userId)
  const isStarter = rootAuthorId === userId
  const isAdmin = isStarter ? false : await isWorkspaceAdmin(prisma, workspaceId, userId)
  if (!canArchiveConversation({ rootAuthorId, userId, isAdmin })) return { ok: false, status: 403 }

  // A message appended while this runs can make the transaction lose a write conflict (Repeatable Read / DSQL); the work is
  // idempotent (compare-and-set stamp, audit row only on a real change, all inside the transaction), so run it again.
  const changed = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    // Compare-and-set on the current state, so a repeat is a no-op (and a double click cannot write two audit rows).
    const stamped = await stampConversationArchived(tx, { conversationId, workspaceId, archived })
    if (!stamped) return false
    // No wake-up may fire into a thread that takes no replies.
    if (archived) await cancelAllPendingConversationWakeups(tx, { conversationId })
    const messageCount = await tx.agentMessage.count({ where: { conversationId } })
    await tx.agentAuditLog.create({
      data: {
        userId,
        workspaceId,
        conversationId: null,
        toolName: archived ? "conversation.archive" : "conversation.restore",
        argsSummary: JSON.stringify({
          conversationId,
          targetType: conversation.targetType,
          targetId: conversation.targetId,
          messageCount,
          actedBy: userId,
          role: isStarter ? "STARTER" : "ADMIN",
        }),
      },
    })
    return true
  }))
  return { ok: true, archived, changed }
}

export type ArchivedConversationRow = {
  id: string
  title: string | null
  summary: string | null
  status: string | null
  agentMode: string | null
  visibility: string | null
  targetType: string | null
  targetId: string | null
  updatedAt: Date
  _count: { messages: number }
}

const ARCHIVED_LIST_CAP = 50
const ARCHIVED_PAGE = 100
const ARCHIVED_MAX_PAGES = 40

/**
 * Archived conversations on one object that THIS caller may restore: everything for an admin, only their own threads
 * otherwise. Titles and summaries of anything else are never read into the response.
 *
 * Who started a thread is the author of its first message, which cannot be expressed as a relation filter, so the
 * query pages through archived rows (newest first) and applies the starter rule to each page until it has collected the
 * cap plus one (the extra row only tells the caller that more exist). The cap therefore applies AFTER the starter rule:
 * a member whose own thread sits behind many newer archived threads by others still finds it. The page budget bounds the
 * work; hitting it reports `capped` too.
 */
export async function listRestorableArchivedConversations(input: {
  workspaceId: string
  userId: string
  targetType: string
  targetId: string
  linkedIds: string[]
}): Promise<{ rows: ArchivedConversationRow[]; capped: boolean }> {
  const { workspaceId, userId, targetType, targetId, linkedIds } = input
  const prisma = getPrisma()
  const where = {
    archivedAt: { not: null },
    visibility: "WORKSPACE",
    interviewProcessingJson: null,
    AND: [
      accessibleConversationsWhere(workspaceId, userId),
      { OR: [{ targetType, targetId }, ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : [])] },
    ],
  }
  const admin = await isWorkspaceAdmin(prisma, workspaceId, userId)
  const collected: Array<ArchivedConversationRow & { userId: string }> = []
  let exhausted = false

  for (let page = 0; page < ARCHIVED_MAX_PAGES && collected.length <= ARCHIVED_LIST_CAP; page++) {
    const batch = (await prisma.agentConversation.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: page * ARCHIVED_PAGE,
      take: ARCHIVED_PAGE,
      select: {
        id: true, userId: true, title: true, summary: true, status: true, agentMode: true, visibility: true,
        targetType: true, targetId: true, updatedAt: true, _count: { select: { messages: true } },
      },
    })) as Array<ArchivedConversationRow & { userId: string }>

    let allowed = batch
    if (!admin && batch.length > 0) {
      const firsts = await prisma.agentMessage.findMany({
        where: { conversationId: { in: batch.map((row) => row.id) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        distinct: ["conversationId"],
        select: { conversationId: true, authorUserId: true, messageKind: true },
      })
      const starter = new Map(firsts.map((first) => [first.conversationId, first]))
      allowed = batch.filter((row) => {
        const first = starter.get(row.id)
        return (first ? effectiveAuthorId({ authorUserId: first.authorUserId ?? null, messageKind: first.messageKind ?? null }, row.userId) : row.userId) === userId
      })
    }
    collected.push(...allowed)
    if (batch.length < ARCHIVED_PAGE) { exhausted = true; break }
  }

  const strip = ({ userId: _owner, ...rest }: ArchivedConversationRow & { userId: string }): ArchivedConversationRow => rest
  return {
    rows: collected.slice(0, ARCHIVED_LIST_CAP).map(strip),
    capped: collected.length > ARCHIVED_LIST_CAP || !exhausted,
  }
}
