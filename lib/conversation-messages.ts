/**
 * Message-level rules for shared conversations (TASK-195 S1): who may edit a message, and the edit itself.
 *
 * The bridge to the legacy comment tables is id equality (see lib/conversation-mirror.ts): for a comment-backed thread
 * a message id is also a `Comment` id. An edit therefore writes BOTH rows in one transaction. Writing only the message
 * would be silently undone the next time `mirrorCommentThread` upserts content from the comment.
 *
 * Permissions are computed here, on the server, and returned to the client as `canEdit`. The client never infers
 * rights from a user id, because workspace and organization admins are not visible to it.
 *
 * Who may edit (Rick's answer, 2026-11-19): the author, or an administrator of the workspace (strict parity with the
 * old Discussion). Never an agent, plan-proposal, system or approval message, and never in a private chat or an
 * interview conversation. Previous text is not retained; the visible audit is `editedAt`.
 *
 * An edit never reorders a list (the conversation's `updatedAt` is carried through unchanged), never notifies again,
 * and never re-runs an agent: a later turn simply reads the edited text.
 */

import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"
import { deriveConversationSummary } from "@/lib/agent-card-derive"
import { deriveConversationTitleFromComment } from "@/lib/conversation-mirror"
import { plainTextOf } from "@/lib/comment-mentions"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"
import { isApprovalUpdateMessage } from "@/lib/tool-approval/messages"

export const MESSAGE_CONTENT_MAX = 20_000

/** Message kinds written for a person's own words. Null covers rows that predate migration 124. */
const EDITABLE_KINDS = new Set<string | null>([null, "MESSAGE", "COMMENT"])

export type EditableMessageFields = {
  role: string
  content: string
  authorUserId: string | null
  authorType: string | null
  messageKind: string | null
}

export type MessageEditContext = {
  ownerUserId: string
  visibility: string | null
  isInterview: boolean
  userId: string
  isAdmin: boolean
}

/** Pure policy: may `ctx.userId` edit this message? */
export function canEditMessage(message: EditableMessageFields, ctx: MessageEditContext): boolean {
  if (ctx.isInterview || ctx.visibility !== "WORKSPACE") return false
  if (message.role !== "user") return false
  if (message.authorType != null && message.authorType !== "HUMAN") return false
  if (!EDITABLE_KINDS.has(message.messageKind)) return false
  if (isApprovalUpdateMessage(message.content)) return false
  // A message that predates sharing has no author on disk and is the conversation owner's.
  const author = message.authorUserId ?? ctx.ownerUserId
  return author === ctx.userId || ctx.isAdmin
}

/** Workspace administrator, or organization owner/admin (the same rule the legacy comment routes used). */
export async function isWorkspaceAdmin(
  prisma: Pick<AppPrismaClient, "workspace">,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      members: { where: { userId }, select: { role: true } },
      organization: { select: { members: { where: { userId }, select: { role: true } } } },
    },
  })
  if (!workspace) return false
  return (
    (workspace.members[0] != null && normalizeWorkspaceRole(workspace.members[0].role) === "ADMIN") ||
    isOrgAdminRole(workspace.organization?.members[0]?.role)
  )
}

export type EditConversation = {
  userId: string
  visibility: string | null
  interviewProcessingJson: string | null
  title: string | null
  summary: string | null
  updatedAt: Date
}

/** The conversation, if (and only if) the caller may see it. Null is reported as 404 by every caller. */
export async function loadAccessibleConversation(
  prisma: Pick<AppPrismaClient, "agentConversation">,
  { conversationId, workspaceId, userId }: { conversationId: string; workspaceId: string; userId: string },
): Promise<EditConversation | null> {
  return prisma.agentConversation.findFirst({
    where: { id: conversationId, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { userId: true, visibility: true, interviewProcessingJson: true, title: true, summary: true, updatedAt: true },
  })
}

export type EditedMessageDto = {
  id: string
  role: string
  content: string
  editedAt: Date
  canEdit: boolean
}

export type EditResult =
  | { ok: true; message: EditedMessageDto }
  | { ok: false; status: 400 | 403 | 404; error: string }

const NOT_FOUND = { ok: false, status: 404, error: "Not found" } as const

/** Both derivations the app uses for an auto-titled conversation: the comment mirror's and the chat turn's. */
function autoTitles(content: string): Array<{ title: string; derive: (text: string) => string }> {
  return [
    { title: deriveConversationTitleFromComment(content), derive: deriveConversationTitleFromComment },
    { title: plainTextOf(content.trim()).slice(0, 80), derive: (text) => plainTextOf(text.trim()).slice(0, 80) },
  ]
}

export async function editConversationMessage(input: {
  conversationId: string
  messageId: string
  workspaceId: string
  userId: string
  content: string
}): Promise<EditResult> {
  const { conversationId, messageId, workspaceId, userId } = input
  const content = input.content.trim()
  if (!content) return { ok: false, status: 400, error: "Write something before saving." }
  if (content.length > MESSAGE_CONTENT_MAX) return { ok: false, status: 400, error: "That message is too long." }

  const prisma = getPrisma()
  const conversation = await loadAccessibleConversation(prisma, { conversationId, workspaceId, userId })
  if (!conversation) return NOT_FOUND

  const message = await prisma.agentMessage.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, role: true, content: true, authorUserId: true, authorType: true, messageKind: true },
  })
  if (!message) return NOT_FOUND

  const ctx: MessageEditContext = {
    ownerUserId: conversation.userId,
    visibility: conversation.visibility,
    isInterview: conversation.interviewProcessingJson != null,
    userId,
    isAdmin: false,
  }
  const author = message.authorUserId ?? conversation.userId
  if (author !== userId) ctx.isAdmin = await isWorkspaceAdmin(prisma, workspaceId, userId)
  // The caller can see this conversation, so 403 leaks nothing the 404 above was hiding.
  if (!canEditMessage(message, ctx)) return { ok: false, status: 403, error: "You can't edit this message." }

  const editedAt = new Date()
  const operation = () =>
    prisma.$transaction(
      async (tx) => {
        // The legacy comment route refuses to edit a plan proposal. A proposal posted as the user's own comment can
        // mirror as an ordinary message first, so the guard has to read the comment row, not trust the message kind.
        const comment = await tx.comment.findUnique({
          where: { id: messageId },
          select: { id: true, workspaceId: true, solutionPlanProposal: { select: { commentId: true } } },
        })
        if (comment?.solutionPlanProposal) return null

        const row = await tx.agentMessage.update({ where: { id: messageId }, data: { content, editedAt } })

        // `edited` on the legacy DTO is `updatedAt !== createdAt`, so the comment moves with the message.
        if (comment && comment.workspaceId === workspaceId) {
          await tx.comment.update({ where: { id: messageId }, data: { body: content, updatedAt: editedAt } })
        }

        // Re-read inside the transaction: the copy read earlier may be stale by now (a reply or an agent turn can have
        // bumped the conversation), and writing it back would silently undo that.
        const fresh = await tx.agentConversation.findUnique({
          where: { id: conversationId },
          select: { title: true, summary: true, updatedAt: true },
        })
        if (fresh) {
          const first = await tx.agentMessage.findFirst({
            where: { conversationId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
          })
          const last = await tx.agentMessage.findFirst({
            where: { conversationId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true },
          })
          // `updatedAt` is restated on purpose: the repo's write extension bumps it to now on any update that omits it,
          // and an edit must not move the conversation in a list.
          const data: { title?: string; summary?: string; updatedAt: Date } = { updatedAt: fresh.updatedAt }
          if (first?.id === messageId && fresh.title != null) {
            const old = autoTitles(message.content).find((candidate) => candidate.title === fresh.title)
            if (old) data.title = old.derive(content)
          }
          if (last?.id === messageId) {
            const summary = deriveConversationSummary(content)
            if (summary) data.summary = summary
          }
          if (data.title !== undefined || data.summary !== undefined) {
            // Conditional on the updatedAt just read: if something bumped the conversation since, skip rather than revert it.
            await tx.agentConversation.updateMany({ where: { id: conversationId, updatedAt: fresh.updatedAt }, data })
          }
        }
        return row
      },
      // Aurora DSQL supports Repeatable Read, not Serializable (same choice as deleteBrowserComment).
      { isolationLevel: "RepeatableRead" },
    )

  let updated: Awaited<ReturnType<typeof operation>> = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      updated = await operation()
      break
    } catch (error) {
      const value = error as { code?: string; meta?: { code?: string }; message?: string }
      // The message was deleted or archived between the read and the write.
      if (value.code === "P2025") return NOT_FOUND
      const retryable =
        value.code === "P2034" || value.code === "40001" || value.meta?.code === "40001" || /OC00\d|serialization/i.test(value.message ?? "")
      if (!retryable || attempt === 2) throw error
    }
  }
  if (!updated) return NOT_FOUND

  return {
    ok: true,
    message: { id: updated.id, role: updated.role, content: updated.content, editedAt, canEdit: true },
  }
}
