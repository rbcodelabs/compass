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
import { deriveConversationSummary } from "@/lib/agent-card-derive"
import { isConversationLinkTarget, recordConversationLink } from "@/lib/links/conversation-links"

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

export function deriveConversationTitleFromComment(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^[#*>\-\s]+/, "").trim())
      .find(Boolean) ?? "Discussion thread"
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
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
      const allMessages = [root, ...replies]
      const lastMessage = allMessages[allMessages.length - 1]!
      const updatedAt = lastMessage.updatedAt > root.updatedAt ? lastMessage.updatedAt : root.updatedAt
      const title = deriveConversationTitleFromComment(root.body)
      const summary = deriveConversationSummary(lastMessage.body) ?? title.slice(0, 140)
      const status = root.status === "RESOLVED" ? "RESOLVED" : "OPEN"
      const resolvedAt = status === "RESOLVED" ? root.updatedAt : null

      await prisma.agentConversation.upsert({
        where: { id: root.id },
        create: {
          id: root.id,
          workspaceId,
          userId: ownerUserId,
          title,
          summary,
          targetType: root.targetType,
          targetId: root.targetId,
          visibility: "WORKSPACE",
          status,
          agentMode: "MENTION_ONLY",
          source: root.source ?? "BROWSER",
          resolvedAt,
          resolvedById: null,
          createdAt: root.createdAt,
          updatedAt,
        },
        update: {
          status,
          resolvedAt,
          summary,
          updatedAt,
        },
      })
      conversationsPromoted++

      for (const item of allMessages) {
        const isAssistant = item.authorType === "AGENT" || item.authorType === "AI"
        const role = isAssistant ? "assistant" : "user"
        const editedAt = item.updatedAt > item.createdAt ? item.updatedAt : null
        await prisma.agentMessage.upsert({
          where: { id: item.id },
          create: {
            id: item.id,
            conversationId: root.id,
            role,
            content: item.body,
            authorUserId: item.authorId,
            authorName: item.authorName,
            authorType: item.authorType ?? (isAssistant ? "AGENT" : "HUMAN"),
            messageKind: "COMMENT",
            editedAt,
            createdAt: item.createdAt,
          },
          update: {
            content: item.body,
            editedAt,
          },
        })
        messagesPromoted++
      }

      if (isConversationLinkTarget(root.targetType)) {
        try {
          const outcome = await recordConversationLink(prisma, {
            conversationId: root.id,
            workspaceId,
            entityType: root.targetType,
            entityId: root.targetId,
            kind: "MENTIONS",
          })
          if (outcome === "created") linksCreated++
        } catch {
          // Best-effort if the target entity was deleted.
        }
      }
    }
  } catch (error) {
    if (!isMissingColumnOrTable(error)) throw error
  }

  return { conversationsPromoted, messagesPromoted, linksCreated }
}
