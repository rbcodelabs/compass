/**
 * Server-side data for the agent board: the card list, and the per-user "reviewed" write.
 *
 * The reviewed flag is per USER, not per conversation: a shared conversation (participants)
 * has one row per person who has opened it, so one person's review never marks another's
 * board. Both the read and the write go through lib/agent-conversation-access.ts, the same
 * predicate the chat uses, so the board can never show or mark a conversation the chat
 * would refuse (including after the caller leaves the workspace).
 *
 * The reviews table arrives with migration 109. Until it is applied the board still works
 * and every card reads as unreviewed; marking returns "unavailable" instead of erroring.
 */

import type { AppPrismaClient } from "@/lib/db"
import { isMissingTable } from "@/lib/batched-delete"
import { accessibleConversationsWhere, resolveConversationAccess } from "@/lib/agent-conversation-access"
import type { AgentBoardCard } from "@/lib/agent-board"

type BoardDb = Pick<AppPrismaClient, "agentConversation" | "agentConversationReview">

/** Enough for any realistic workspace; the board is a triage surface, not an archive. */
const BOARD_LIMIT = 100

export async function listAgentBoardCards(
  prisma: BoardDb,
  { workspaceId, userId }: { workspaceId: string; userId: string }
): Promise<AgentBoardCard[]> {
  const conversations = await prisma.agentConversation.findMany({
    where: accessibleConversationsWhere(workspaceId, userId),
    orderBy: { updatedAt: "desc" },
    take: BOARD_LIMIT,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, statusChangedAt: true } },
    },
  })
  if (conversations.length === 0) return []

  let reviewedAt = new Map<string, Date>()
  try {
    const reviews = await prisma.agentConversationReview.findMany({
      // The caller's rows only: another participant's review is never visible here.
      where: { userId, workspaceId, conversationId: { in: conversations.map((c) => c.id) } },
      select: { conversationId: true, reviewedAt: true },
    })
    reviewedAt = new Map(reviews.map((r) => [r.conversationId, r.reviewedAt]))
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }

  return conversations.map((c) => {
    const run = c.runs[0] ?? null
    const lastActivity = run && run.statusChangedAt > c.updatedAt ? run.statusChangedAt : c.updatedAt
    return {
      id: c.id,
      title: c.title,
      messageCount: c._count.messages,
      runStatus: run?.status ?? null,
      lastActivityAt: lastActivity.toISOString(),
      reviewedAt: reviewedAt.get(c.id)?.toISOString() ?? null,
    }
  })
}

export type MarkReviewedResult = { ok: true } | { ok: false; reason: "not_found" | "unavailable" }

/** Records that `userId` has looked at a conversation as of `now`. "not_found" covers both missing and not-yours. */
export async function markConversationReviewed(
  prisma: BoardDb,
  { conversationId, workspaceId, userId, now = new Date() }: { conversationId: string; workspaceId: string; userId: string; now?: Date }
): Promise<MarkReviewedResult> {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) return { ok: false, reason: "not_found" }
  try {
    await prisma.agentConversationReview.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, workspaceId, userId, reviewedAt: now, createdAt: now, updatedAt: now },
      update: { reviewedAt: now, updatedAt: now },
    })
  } catch (error) {
    if (isMissingTable(error)) return { ok: false, reason: "unavailable" }
    throw error
  }
  return { ok: true }
}

/**
 * Removes every review row in a workspace. Workspace deletion calls this before it deletes the conversations the
 * rows point at (relationMode "prisma" enforces nothing in the database, so nothing cascades). Tolerates the
 * reviews migration being unapplied, so a deployment that has not applied it can still delete a workspace.
 */
export async function deleteWorkspaceConversationReviews(
  prisma: Pick<AppPrismaClient, "agentConversationReview">,
  workspaceId: string
): Promise<void> {
  try {
    await prisma.agentConversationReview.deleteMany({ where: { workspaceId } })
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }
}
