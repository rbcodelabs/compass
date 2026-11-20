/**
 * Read side of "tasks from a conversation" (TASK-195 S4). A task made from a root post is a `Comment` write (the comment is
 * the write path for task-bearing threads, and the mirror gives the conversation and message the comment's id), so the card
 * for a message is the card of the comment with the same id. Both lookups here are enrichments of a list or transcript that
 * already loaded: a failure degrades to "no cards" / "no known agents", never to a failed read, and logs only the error
 * name so no comment text can reach a log line.
 */
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import { COMMENT_TARGET_TYPES, type CommentTargetType } from "@/lib/comments"

function logFailure(what: string, error: unknown) {
  console.error(`[conversation-task-cards] ${what} failed`, error instanceof Error ? error.name : "unknown")
}

/** Task card per message id (the id of the comment the task was created from). Empty on any failure. */
export async function loadConversationTaskCards(workspaceId: string, messageIds: string[]): Promise<Record<string, CommentTaskCardData>> {
  if (messageIds.length === 0) return {}
  try {
    const { loadCommentTaskCards } = await import("@/lib/doc-comment-tasks")
    return await loadCommentTaskCards(workspaceId, messageIds)
  } catch (error) {
    logFailure("task card lookup", error)
    return {}
  }
}

export type TaskComposerContext = { confirmedAgentIds: string[]; targetTitle: string | null }

const isTaskTarget = (targetType: string): targetType is CommentTargetType =>
  targetType !== "DOC" && (COMMENT_TARGET_TYPES as readonly string[]).includes(targetType)

/**
 * What the composer's task row needs about the commented item: which agents already hold a task from a comment on it (their
 * scope confirmation is skipped) and its title (copy only). Docs keep their own comment flow, and a type that cannot carry
 * comments cannot carry a task, so both get the empty context.
 */
export async function loadTaskComposerContext(workspaceId: string, targetType: string, targetId: string): Promise<TaskComposerContext> {
  if (!isTaskTarget(targetType)) return { confirmedAgentIds: [], targetTitle: null }
  try {
    const { agentIdsAssignedOnTarget, targetTitle } = await import("@/lib/comment-target-tasks")
    const [confirmedAgentIds, title] = await Promise.all([
      agentIdsAssignedOnTarget(workspaceId, targetType, targetId).catch((error) => { logFailure("known agent lookup", error); return [] as string[] }),
      targetTitle(workspaceId, targetType, targetId).catch((error) => { logFailure("target title lookup", error); return null }),
    ])
    return { confirmedAgentIds, targetTitle: title }
  } catch (error) {
    logFailure("task composer context", error)
    return { confirmedAgentIds: [], targetTitle: null }
  }
}
