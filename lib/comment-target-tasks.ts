/**
 * @mentions and optional task assignment for Discussion comments (every comment
 * target except DOC, which keeps its own flow in lib/doc-comment-tasks.ts and
 * shares the validation, task card and notification code with this module).
 *
 * Comments live in the unified `Comment` table, so a task made from one links to
 * that comment id with `TaskLink.linkedType = "COMMENT"` (thread sync + the task's
 * "Comment" link) and, where the target type has a task link type, to the
 * commented item too so the task is listed under it. Targets with no link type
 * (see TASK_LINK_TYPE_FOR_TARGET) get the COMMENT link only.
 */
import getPrisma from "@/lib/db"
import { createComment, getComment, type CommentTargetType } from "@/lib/comments"
import { mentionRoles, uniqueMentions } from "@/lib/comment-mentions"
import {
  notifyMentions, parseDueDate, planCommentTask, toCard,
  type CommentTaskRequest, type PostCommentError,
} from "@/lib/doc-comment-tasks"
import { resolveTaskAssignees } from "@/lib/task-assignment"
import { getTasksLinkedToOrigin } from "@/lib/task-links-read"
import { createWorkspaceTask } from "@/lib/task-create"
import { runAfterCommit } from "@/lib/following-commit"
import { removeCommentMirrorAfterCommit } from "@/lib/conversation-mirror"
import { getFollowable, isSubjectTypeActive } from "@/lib/followable"
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import type { TaskLinkedType } from "@/lib/types"

/**
 * The task link type that lists a task under the commented item. Assumptions,
 * Artifacts, Research studies and Tasks have none (task links cannot point at
 * them), so a task from a comment there carries only the COMMENT link.
 */
export const TASK_LINK_TYPE_FOR_TARGET: Partial<Record<CommentTargetType, TaskLinkedType>> = {
  OBJECTIVE: "OBJECTIVE",
  KEY_RESULT: "KEY_RESULT",
  OPPORTUNITY: "OPPORTUNITY",
  SOLUTION: "SOLUTION",
  EXPERIMENT: "EXPERIMENT",
  ROADMAP_ITEM: "ROADMAP_ITEM",
  FEEDBACK_ITEM: "FEEDBACK_ITEM",
  DOC: "DOC",
  REVIEW_REQUEST: "DECISION",
}

export type TargetPostError = PostCommentError | "COMMENT_FAILED"

export interface PostTargetCommentInput {
  workspaceId: string
  targetType: CommentTargetType
  targetId: string
  userId: string
  userName: string
  body: string
  parentId?: string | null
  task?: CommentTaskRequest | null
  assignee?: { kind: "user" | "agent"; id: string } | null
  agentScopeConfirmed?: boolean
}

export type PostTargetCommentResult =
  | { ok: true; comment: NonNullable<Awaited<ReturnType<typeof getComment>>>; card: CommentTaskCardData | null }
  | { ok: false; error: TargetPostError; message?: string }

/** Agents that already hold a task made from a comment on this target (the scope-confirm step is skipped for them). */
export async function agentIdsAssignedOnTarget(workspaceId: string, targetType: CommentTargetType, targetId: string): Promise<string[]> {
  const prisma = getPrisma()
  // Bounded: the newest 1000 comments on the item. Missing an older agent only means one more scope confirmation, never a skipped one.
  const commentIds = (await prisma.comment.findMany({ where: { workspaceId, targetType, targetId }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 1000 })).map(c => c.id)
  if (commentIds.length === 0) return []
  const linkedTaskIds = [...new Set((await getTasksLinkedToOrigin(prisma, { workspaceId, linkedType: "COMMENT", linkedIds: commentIds })).map(link => link.taskId))]
  if (linkedTaskIds.length === 0) return []
  const tasks = await prisma.task.findMany({
    where: { workspaceId, assigneeAgentId: { not: null }, id: { in: linkedTaskIds } },
    select: { assigneeAgentId: true },
  })
  return [...new Set(tasks.flatMap(t => (t.assigneeAgentId ? [t.assigneeAgentId] : [])))]
}

const noun = (targetType: CommentTargetType) => targetType.toLowerCase().replace(/_/g, " ")

export async function targetTitle(workspaceId: string, targetType: CommentTargetType, targetId: string): Promise<string | null> {
  try {
    const display = await getFollowable(targetType)?.resolveDisplay(workspaceId, [targetId], getPrisma())
    return display?.get(targetId)?.title ?? null
  } catch {
    return null
  }
}

/**
 * Notifications for a mention follow the commented item when that type is live in the following system. Where it is
 * not yet, a mention that came with a task notifies through the task (watchers follow it); a plain mention there has
 * no subject to notify through and is skipped by the notification layer.
 */
function notificationSubject(targetType: CommentTargetType, targetId: string, taskId: string | null) {
  if (isSubjectTypeActive(targetType) || !taskId) return { subjectType: targetType, subjectId: targetId }
  return { subjectType: "TASK", subjectId: taskId }
}

export async function postTargetCommentWithOptionalTask(input: PostTargetCommentInput): Promise<PostTargetCommentResult> {
  const prisma = getPrisma()
  const body = input.body.trim()
  if (!body) return { ok: false, error: "EMPTY_BODY" }

  const roles = mentionRoles(body, input.assignee)
  let assignee: { type: "USER" | "AGENT"; id: string } | null = null

  if (input.task) {
    // Same write gate as Doc comments: only a real WorkspaceMember row can create tasks.
    const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: input.workspaceId, userId: input.userId }, select: { id: true } })
    if (!member) return { ok: false, error: "FORBIDDEN" }
    const plan = await planCommentTask({
      workspaceId: input.workspaceId, task: input.task, roles, agentScopeConfirmed: input.agentScopeConfirmed,
      knownAgentIds: () => agentIdsAssignedOnTarget(input.workspaceId, input.targetType, input.targetId),
    })
    if (!plan.ok) return plan
    assignee = plan.assignee
  }

  let created: Awaited<ReturnType<typeof createComment>>
  try {
    created = await createComment({
      workspaceId: input.workspaceId, targetType: input.targetType, targetId: input.targetId, parentId: input.parentId ?? null,
      body, authorId: input.userId, authorName: input.userName, authorType: "HUMAN", source: "UI",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "The comment could not be posted."
    return { ok: false, error: /parent comment/i.test(message) ? "PARENT_NOT_FOUND" : /threads are only one level/i.test(message) ? "PARENT_IS_REPLY" : "COMMENT_FAILED", message }
  }
  if (!created) return { ok: false, error: "COMMENT_FAILED" }

  let card: CommentTaskCardData | null = null
  let taskId: string | null = null
  if (input.task && assignee) {
    let task: Awaited<ReturnType<typeof createWorkspaceTask>>
    try {
      const title = await targetTitle(input.workspaceId, input.targetType, input.targetId)
      const linkType = TASK_LINK_TYPE_FOR_TARGET[input.targetType]
      task = await createWorkspaceTask(input.workspaceId, {
        title: input.task.title.trim().slice(0, 255),
        description: `From a comment on the ${noun(input.targetType)}${title ? ` “${title}”` : ""}.`,
        priority: input.task.priority ?? "MEDIUM",
        dueDate: input.task.dueDate ? parseDueDate(input.task.dueDate) : null,
        assignee,
        links: [{ linkedType: "COMMENT", linkedId: created.id }, ...(linkType ? [{ linkedType: linkType, linkedId: input.targetId }] : [])],
      })
    } catch (error) {
      // Only a task that was NOT created withdraws the comment. Log the error name and code, never its message (it can carry
      // column names or values), and answer with a fixed message.
      console.error("[comment-target-tasks] task creation failed", error instanceof Error ? error.name : "unknown", (error as { code?: unknown })?.code ?? "")
      // Do not leave a comment that promised a task but has none behind.
      let commentDeleted = false
      try {
        await prisma.comment.deleteMany({ where: { id: created.id } })
        commentDeleted = true
      } catch (cleanupError) {
        console.error("[comment-target-tasks] cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown")
      }
      // The comment was mirrored into a conversation after it committed (TASK-195 S0): withdraw that too, or the failed post
      // would leave a ghost conversation and message the list shows. Only after the comment itself is gone, so a mirror is
      // never removed from under a comment that still exists. A root takes its conversation with it when it is a pure mirror
      // (the one named hard delete in lib/conversation-mirror.ts; archived blank if a panel message landed meanwhile); a
      // reply only loses its own message.
      if (commentDeleted) {
        await removeCommentMirrorAfterCommit(created.parentId
          ? { conversationId: created.parentId, commentIds: [created.id], threadDeleted: false }
          : { conversationId: created.id, commentIds: [created.id], threadDeleted: true })
      }
      return { ok: false, error: "TASK_FAILED", message: "Could not create the task." }
    }
    // The task is committed from here on. Nothing below may withdraw the comment: a failure only costs the card.
    taskId = task.id
    try {
      const [resolved] = await resolveTaskAssignees(input.workspaceId, [task])
      card = toCard({ ...task, assignee: resolved.assignee ? { type: resolved.assignee.type, id: resolved.assignee.id, displayName: resolved.assignee.displayName, available: resolved.assignee.available } : null })
    } catch (error) {
      console.error("[comment-target-tasks] task card failed", error instanceof Error ? error.name : "unknown")
    }
  }

  const subject = notificationSubject(input.targetType, input.targetId, taskId)
  await runAfterCommit(() => notifyMentions({
    workspaceId: input.workspaceId, ...subject, commentId: created.id, actorId: input.userId,
    taskId, mentions: uniqueMentions(body), taskAssigneeUserId: assignee?.type === "USER" && taskId ? assignee.id : null,
  }))

  return { ok: true, comment: created, card }
}
