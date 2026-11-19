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
 * back to the conversation owner for rows that predate author tracking), a workspace admin, or an organization
 * owner/admin. The same rule is used to decide who is shown an archived thread in the "Show archived" list, so a
 * person who cannot restore it never learns its title or summary. A conversation the caller cannot see is a 404
 * (never 403, see lib/agent-conversation-access.ts); a member who can see it without the right gets a 403.
 *
 * Privacy: archiving does not redact. Reads (`accessibleConversationsWhere`) deliberately carry no `archivedAt`
 * clause, so an archived thread stays readable by exactly the people who could read it before, by id.
 *
 * Private chats keep their older rule (owner-only, see setAgentConversationArchived) and are not audited here.
 *
 * `updatedAt`: Prisma's updatedAt write extension stamps `now` on any update that omits it. Archive and restore carry
 * the conversation's own value through unchanged, so neither action reorders a list.
 *
 * Each real change writes a content-free AgentAuditLog row in the same transaction (ids, role, count; never text).
 * `conversationId` on that row is null on purpose: the audit must survive anything that later sweeps a conversation's
 * own audit rows, and S0's mirror-purge treats a conversation that still has audit rows as "has content".
 */

import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { isWorkspaceAdmin } from "@/lib/conversation-messages"
import { setAgentConversationArchived } from "@/lib/agent-conversations"

export type ArchiveResult =
  | { ok: true; archived: boolean; changed: boolean }
  | { ok: false; status: 403 | 404 }

/** Pure policy: may this user archive or restore a thread started by `rootAuthorId`? */
export function canArchiveConversation(input: { rootAuthorId: string; userId: string; isAdmin: boolean }): boolean {
  return input.rootAuthorId === input.userId || input.isAdmin
}

/** The thread starter: whoever wrote its first message, else the conversation owner. */
async function rootAuthorOf(
  prisma: Pick<AppPrismaClient, "agentMessage">,
  conversationId: string,
  ownerUserId: string,
): Promise<string> {
  const first = await prisma.agentMessage.findFirst({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { authorUserId: true },
  })
  return first?.authorUserId ?? ownerUserId
}

/**
 * Whether the caller may archive (and, symmetrically, restore) this SHARED conversation. Computed on the server and
 * handed to the client as `canArchive` / `canRestore`; the client never infers it, because admins are not visible to it.
 * False for private chats, interview conversations and anything the caller cannot see.
 */
export async function canArchiveSharedConversation(input: {
  conversationId: string
  workspaceId: string
  userId: string
}): Promise<boolean> {
  const { conversationId, workspaceId, userId } = input
  const prisma = getPrisma()
  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { userId: true, visibility: true, interviewProcessingJson: true },
  })
  if (!conversation || conversation.visibility !== "WORKSPACE" || conversation.interviewProcessingJson != null) return false
  const rootAuthorId = await rootAuthorOf(prisma, conversationId, conversation.userId)
  const isAdmin = rootAuthorId === userId ? false : await isWorkspaceAdmin(prisma, workspaceId, userId)
  return canArchiveConversation({ rootAuthorId, userId, isAdmin })
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
    select: { userId: true, visibility: true, interviewProcessingJson: true, updatedAt: true, targetType: true, targetId: true },
  })
  if (!conversation) return { ok: false, status: 404 }

  // Private chats and interview conversations: unchanged owner-only behaviour, 404 for everyone else.
  if (conversation.visibility !== "WORKSPACE" || conversation.interviewProcessingJson != null) {
    if (conversation.userId !== userId) return { ok: false, status: 404 }
    const ok = await setAgentConversationArchived(conversationId, workspaceId, userId, archived)
    return ok ? { ok: true, archived, changed: true } : { ok: false, status: 404 }
  }

  const rootAuthorId = await rootAuthorOf(prisma, conversationId, conversation.userId)
  const isStarter = rootAuthorId === userId
  const isAdmin = isStarter ? false : await isWorkspaceAdmin(prisma, workspaceId, userId)
  if (!canArchiveConversation({ rootAuthorId, userId, isAdmin })) return { ok: false, status: 403 }

  const changed = await prisma.$transaction(async (tx) => {
    // Guarded on the current state so a repeat is a no-op (and a double click cannot write two audit rows).
    const { count } = await tx.agentConversation.updateMany({
      where: { id: conversationId, workspaceId, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null, updatedAt: conversation.updatedAt },
    })
    if (count === 0) return false
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
  })
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

/**
 * Archived conversations on one object that THIS caller may restore: everything for an admin, only their own threads
 * otherwise. Titles and summaries of anything else are never read into the response.
 */
export async function listRestorableArchivedConversations(input: {
  workspaceId: string
  userId: string
  targetType: string
  targetId: string
  linkedIds: string[]
}): Promise<ArchivedConversationRow[]> {
  const { workspaceId, userId, targetType, targetId, linkedIds } = input
  const prisma = getPrisma()
  const rows = (await prisma.agentConversation.findMany({
    where: {
      archivedAt: { not: null },
      visibility: "WORKSPACE",
      interviewProcessingJson: null,
      AND: [
        accessibleConversationsWhere(workspaceId, userId),
        { OR: [{ targetType, targetId }, ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : [])] },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true, userId: true, title: true, summary: true, status: true, agentMode: true, visibility: true,
      targetType: true, targetId: true, updatedAt: true, _count: { select: { messages: true } },
    },
  })) as Array<ArchivedConversationRow & { userId: string }>
  if (rows.length === 0) return []

  const admin = await isWorkspaceAdmin(prisma, workspaceId, userId)
  const strip = ({ userId: _owner, ...rest }: ArchivedConversationRow & { userId: string }): ArchivedConversationRow => rest
  if (admin) return rows.map(strip)

  const firsts = await prisma.agentMessage.findMany({
    where: { conversationId: { in: rows.map((row) => row.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    distinct: ["conversationId"],
    select: { conversationId: true, authorUserId: true },
  })
  const starter = new Map(firsts.map((first) => [first.conversationId, first.authorUserId]))
  return rows.filter((row) => (starter.get(row.id) ?? row.userId) === userId).map(strip)
}
