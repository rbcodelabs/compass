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
import { createWorkspaceTask } from "@/lib/task-create"
import { runAfterCommit } from "@/lib/following-commit"
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
  const commentIds = (await prisma.comment.findMany({ where: { workspaceId, targetType, targetId }, select: { id: true } })).map(c => c.id)
  if (commentIds.length === 0) return []
  const tasks = await prisma.task.findMany({
    where: { workspaceId, assigneeAgentId: { not: null }, links: { some: { linkedType: "COMMENT", linkedId: { in: commentIds } } } },
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
    try {
      const title = await targetTitle(input.workspaceId, input.targetType, input.targetId)
      const linkType = TASK_LINK_TYPE_FOR_TARGET[input.targetType]
      const task = await createWorkspaceTask(input.workspaceId, {
        title: input.task.title.trim().slice(0, 255),
        description: `From a comment on the ${noun(input.targetType)}${title ? ` “${title}”` : ""}.`,
        priority: input.task.priority ?? "MEDIUM",
        dueDate: input.task.dueDate ? parseDueDate(input.task.dueDate) : null,
        assignee,
        links: [{ linkedType: "COMMENT", linkedId: created.id }, ...(linkType ? [{ linkedType: linkType, linkedId: input.targetId }] : [])],
      })
      taskId = task.id
      const [resolved] = await resolveTaskAssignees(input.workspaceId, [task])
      card = toCard({ ...task, assignee: resolved.assignee ? { type: resolved.assignee.type, id: resolved.assignee.id, displayName: resolved.assignee.displayName, available: resolved.assignee.available } : null })
    } catch (error) {
      // Do not leave a comment that promised a task but has none behind.
      await prisma.comment.deleteMany({ where: { id: created.id } }).catch(cleanupError => console.error("[comment-target-tasks] cleanup failed", cleanupError))
      return { ok: false, error: "TASK_FAILED", message: error instanceof Error ? error.message : "Could not create the task." }
    }
  }

  const subject = notificationSubject(input.targetType, input.targetId, taskId)
  await runAfterCommit(() => notifyMentions({
    workspaceId: input.workspaceId, ...subject, commentId: created.id, actorId: input.userId,
    taskId, mentions: uniqueMentions(body), taskAssigneeUserId: assignee?.type === "USER" && taskId ? assignee.id : null,
  }))

  return { ok: true, comment: created, card }
}
