/**
 * Read access for the agent chat UI (Phase 4). Who may see a conversation is
 * decided in one place, lib/agent-conversation-access.ts; these
 * helpers go through it rather than restating the predicate, so a user only
 * ever reads conversations they can access in a workspace they belong to.
 */

import getPrisma from "@/lib/db"
import { agentParticipantsAvailable } from "@/lib/agent-conversation-participants"
import { sanitizeAuthorLabel } from "@/lib/agent-author-label"
import { accessibleConversationsWhere, resolveConversationAccess } from "@/lib/agent-conversation-access"

export type ConversationSummary = {
  id: string
  title: string | null
  updatedAt: Date
}

export type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: Date
  /**
   * Who sent a user message. A message that predates sharing carries no
   * author on disk and is reported as the conversation owner's; assistant messages
   * are `null` because the agent is not a participant.
   */
  authorUserId: string | null
  authorName: string | null
}

/** The conversations a user can access in a workspace, most-recently-updated first. */
export async function listAgentConversations(
  workspaceId: string,
  userId: string
): Promise<ConversationSummary[]> {
  const prisma = getPrisma()
  return prisma.agentConversation.findMany({
    where: accessibleConversationsWhere(workspaceId, userId),
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
    take: 50,
  })
}

/**
 * Messages for one conversation, oldest-first. Returns null if the conversation
 * doesn't exist or this user can't access it in this workspace (no data leak).
 */
export async function getAgentConversationMessages(
  conversationId: string,
  workspaceId: string,
  userId: string,
  options: {
    /**
     * Polling cursor: only messages created at or after this instant. Inclusive on
     * purpose, so two messages sharing a millisecond cannot be skipped; callers
     * dedupe by id.
     */
    after?: Date
  } = {}
): Promise<ChatMessage[] | null> {
  const prisma = getPrisma()
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) return null
  const withAuthor = await agentParticipantsAvailable(prisma)
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId, ...(options.after ? { createdAt: { gte: options.after } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: withAuthor
      ? { id: true, role: true, content: true, createdAt: true, authorUserId: true }
      : { id: true, role: true, content: true, createdAt: true },
  })

  const authored = rows.map((row) => ({
    row,
    authorUserId:
      row.role === "user" ? ((row as { authorUserId?: string | null }).authorUserId ?? access.ownerUserId) : null,
  }))
  const ids = [...new Set(authored.flatMap((a) => (a.authorUserId ? [a.authorUserId] : [])))]
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
    : []
  const names = new Map(users.map((u) => [u.id, sanitizeAuthorLabel(u.name, u.email)]))

  return authored.map(({ row, authorUserId }) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    authorUserId,
    authorName: authorUserId ? (names.get(authorUserId) ?? null) : null,
  }))
}
