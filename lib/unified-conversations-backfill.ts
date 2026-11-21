/**
 * Idempotent UUID-preserving promotion of legacy Discussion `Comment` threads into
 * unified `AgentConversation` + `AgentMessage` records (OPP-67 / SOL-117).
 *
 * Root comments (`parentId IS NULL`) become `AgentConversation` rows with the same UUID
 * (`AgentConversation.id = Comment.id`) so all four comment sidecar tables (`DocCommentAnchor`,
 * `SolutionPlanProposal`, `CommentElementAnchor`, `CommentExternalAuthor`) and task origin links
 * remain valid without a redirect table. Root comments and their replies are upserted as
 * chronological `AgentMessage` rows (`AgentMessage.id = Comment.id`).
 */

import type { AppPrismaClient } from "@/lib/db"
import { deriveConversationTitleFromComment, mirrorCommentThread } from "@/lib/conversation-mirror"

export { deriveConversationTitleFromComment }

export const PROTOTYPE_MOCK_CONVERSATION_IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
  "00000000-0000-4000-8000-000000000103",
  "00000000-0000-4000-8000-000000000104",
  "00000000-0000-4000-8000-000000000105",
] as const

export const PROTOTYPE_MOCK_TASK_IDS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
] as const

function isMissingColumnOrTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "P2021" || (error as { code?: unknown }).code === "P2022")
  )
}

export type BackfillUnifiedConversationsResult = {
  conversationsPromoted: number
  messagesPromoted: number
  linksCreated: number
}

/**
 * Promotes root `Comment` rows and their replies in `workspaceId` into `AgentConversation`
 * and `AgentMessage` rows. Safe to call repeatedly (idempotent by UUID).
 */
export async function backfillUnifiedConversations(
  prisma: AppPrismaClient,
  { workspaceId, fallbackUserId }: { workspaceId: string; fallbackUserId?: string },
): Promise<BackfillUnifiedConversationsResult> {
  let conversationsPromoted = 0
  let messagesPromoted = 0
  let linksCreated = 0

  try {
    const comments = await prisma.comment.findMany({
      where: { workspaceId },
      include: { solutionPlanProposal: { select: { commentId: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    if (comments.length === 0) {
      return { conversationsPromoted: 0, messagesPromoted: 0, linksCreated: 0 }
    }

    let resolvedFallbackUserId = fallbackUserId ?? null
    if (!resolvedFallbackUserId) {
      const member = await prisma.workspaceMember.findFirst({
        where: { workspaceId },
        select: { userId: true },
      })
      resolvedFallbackUserId = member?.userId ?? null
    }

    const roots = comments.filter((c) => c.parentId === null)
    const repliesByParent = new Map<string, typeof comments>()
    for (const c of comments) {
      if (!c.parentId) continue
      const list = repliesByParent.get(c.parentId) ?? []
      list.push(c)
      repliesByParent.set(c.parentId, list)
    }

    for (const root of roots) {
      const ownerUserId = root.authorId ?? resolvedFallbackUserId
      if (!ownerUserId) continue

      const replies = repliesByParent.get(root.id) ?? []
      const { messagesPromoted: promoted, linkCreated } = await mirrorCommentThread(prisma, { root, replies, ownerUserId })
      conversationsPromoted++
      messagesPromoted += promoted
      if (linkCreated) linksCreated++
    }
  } catch (error) {
    if (!isMissingColumnOrTable(error)) throw error
  }

  return { conversationsPromoted, messagesPromoted, linksCreated }
}
