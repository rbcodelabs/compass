/**
 * The single answer to "may this user see this agent conversation?"
 *.
 *
 * Until this existed, every conversation route hand-repeated the same predicate,
 * `{ id, workspaceId, userId, workspace: { members: { some: { userId } } } }`, and
 * each copy was a chance to forget the `workspace.members` half. That half is the
 * real authorization boundary: rows are keyed by user *and* workspace, so scoping by
 * `userId` alone would still let someone who has been removed from a workspace read
 * back their old conversations there.
 *
 * ## Contract
 *
 * - Workspace membership is checked live on every call, never cached, so removing a
 *   member from a workspace cuts off their conversations immediately.
 * - "No access" is `null`, and callers report it as 404, never 403, so a conversation
 *   the caller may not see is indistinguishable from one that does not exist.
 * - This module does not validate id shape. `AgentConversation.id` is `@db.Uuid`, so
 *   routes that take an id from a URL should reject a malformed one before calling.
 *
 * ## Owner and participants
 *
 * The OWNER is `AgentConversation.userId`; there is no owner row in
 * `agent_conversation_participants`, so conversations that predate sharing keep working
 * with no backfill. A PARTICIPANT is an active row there (`removedAt` null). Both still
 * have to be live members of the workspace. Handoff/interview conversations
 * (`interviewProcessingJson` set) stay owner-only: a participant row on one is ignored.
 * Every caller goes through here, so widening access changed this file and no call site.
 */

import type { AppPrismaClient } from "@/lib/db"

export type ConversationRole = "OWNER" | "PARTICIPANT"

export type ConversationAccess = { role: ConversationRole; ownerUserId: string }

/** Anything with an `agentConversation` delegate, so a transaction client works too. */
type ConversationDb = Pick<AppPrismaClient, "agentConversation">

/**
 * The `where` for "conversations this user OWNS in this workspace, and is still a
 * member of that workspace". Use this for surfaces that stay owner-only even once
 * conversations can be shared: handoff/interview conversations (those stay
 * out of scope for participants).
 */
export function ownedConversationsWhere(workspaceId: string, userId: string) {
  return {
    workspaceId,
    userId,
    // The authorization boundary — see the module doc.
    workspace: { members: { some: { userId } } },
  }
}

/**
 * The `where` for "conversations this user can see in this workspace": the ones they
 * own, plus the (non-interview) ones they have been invited into and not left or been
 * removed from. The one place the general predicate is spelled out:
 * `resolveConversationAccess` and the list query both build on it, so they cannot drift.
 */
export function accessibleConversationsWhere(workspaceId: string, userId: string) {
  return {
    workspaceId,
    // The authorization boundary — see the module doc.
    workspace: { members: { some: { userId } } },
    OR: [
      { userId },
      {
        interviewProcessingJson: null,
        participants: { some: { userId, workspaceId, removedAt: null } },
      },
    ],
  }
}

/** The caller's role in one conversation, or `null` if they may not see it. */
export async function resolveConversationAccess(
  prisma: ConversationDb,
  { conversationId, workspaceId, userId }: { conversationId: string; workspaceId: string; userId: string }
): Promise<ConversationAccess | null> {
  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { userId: true },
  })
  if (!conversation) return null
  return { role: conversation.userId === userId ? "OWNER" : "PARTICIPANT", ownerUserId: conversation.userId }
}
