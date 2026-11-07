/**
 * Read access for the agent chat UI (Phase 4). Who may see a conversation is
 * decided in one place, lib/agent-conversation-access.ts; these
 * helpers go through it rather than restating the predicate, so a user only
 * ever reads conversations they can access in a workspace they belong to.
 */

import getPrisma from "@/lib/db"
import { agentParticipantsAvailable } from "@/lib/agent-conversation-participants"
import { sanitizeAuthorLabel } from "@/lib/agent-author-label"
import { accessibleConversationsWhere, ownedConversationsWhere, resolveConversationAccess } from "@/lib/agent-conversation-access"

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

/**
 * The conversations a user can access in a workspace, most-recently-updated first.
 * Archived chats are excluded unless `archived` is true, in which case ONLY archived
 * chats are returned.
 */
export async function listAgentConversations(
  workspaceId: string,
  userId: string,
  { archived = false }: { archived?: boolean } = {}
): Promise<ConversationSummary[]> {
  const prisma = getPrisma()
  return prisma.agentConversation.findMany({
    where: { ...accessibleConversationsWhere(workspaceId, userId), archivedAt: archived ? { not: null } : null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
    take: 50,
  })
}

export type ConversationSearchResult = ConversationSummary & {
  /** Short excerpt around the first matching message, or null for a title-only match. */
  snippet: string | null
}

export const CONVERSATION_SEARCH_MAX_QUERY = 100
export const CONVERSATION_SEARCH_LIMIT = 30
const SNIPPET_RADIUS = 60

/** A one-line excerpt of `content` centred on the first case-insensitive hit of `q`. */
export function buildSnippet(content: string, q: string): string {
  const flat = content.replace(/\s+/g, " ").trim()
  const at = flat.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + q.length + SNIPPET_RADIUS)
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "")
}

/**
 * Whole-conversation search: conversations the user can access whose title or any
 * message contains `query` (case-insensitive substring; works on both DSQL and plain
 * Postgres, no extensions). Builds on the shared access predicate so results can never
 * include a conversation the caller may not see.
 */
export async function searchAgentConversations(
  workspaceId: string,
  userId: string,
  query: string
): Promise<ConversationSearchResult[]> {
  const q = query.trim().slice(0, CONVERSATION_SEARCH_MAX_QUERY)
  if (!q) return []
  const prisma = getPrisma()
  const match = { contains: q, mode: "insensitive" as const }
  const access = accessibleConversationsWhere(workspaceId, userId)
  const rows = await prisma.agentConversation.findMany({
    where: {
      AND: [access, { archivedAt: null }, { OR: [{ title: match }, { messages: { some: { content: match } } }] }],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
    take: CONVERSATION_SEARCH_LIMIT,
  })
  if (rows.length === 0) return []

  const hits = await prisma.agentMessage.findMany({
    where: { conversationId: { in: rows.map((r) => r.id) }, content: match },
    orderBy: { createdAt: "desc" },
    select: { conversationId: true, content: true },
    take: rows.length * 5,
  })
  const snippets = new Map<string, string>()
  for (const hit of hits) {
    if (!snippets.has(hit.conversationId)) snippets.set(hit.conversationId, buildSnippet(hit.content, q))
  }
  return rows.map((r) => ({ ...r, snippet: snippets.get(r.id) ?? null }))
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

/**
 * Archive or restore a conversation. Owner-only: a participant who wants a shared chat
 * out of their way leaves it instead. Returns false when the caller is not the owner (or
 * has no access), which routes report as 404.
 */
export async function setAgentConversationArchived(
  conversationId: string,
  workspaceId: string,
  userId: string,
  archived: boolean
): Promise<boolean> {
  const prisma = getPrisma()
  const { count } = await prisma.agentConversation.updateMany({
    where: { id: conversationId, ...ownedConversationsWhere(workspaceId, userId) },
    data: { archivedAt: archived ? new Date() : null },
  })
  return count > 0
}
