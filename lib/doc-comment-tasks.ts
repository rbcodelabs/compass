/**
 * Doc comment @mentions that become Tasks.
 *
 * Which comment model: the Docs UI reads and writes the legacy `DocComment`
 * table (lib/doc-comments.ts), which dual-writes a mirror row into the unified
 * `Comment` table under the SAME id. Task links therefore point at that shared
 * id with `TaskLink.linkedType = "COMMENT"`; no column is added to Task or
 * Comment.
 *
 * Responsibilities, all behind one membership check:
 *   - mention candidates for the picker (members, active granted agents, and,
 *     separately, org members outside the workspace for the "no access" case)
 *   - posting a comment with an optional task: the first mention is the
 *     assignee, further mentions are watchers (notified only), one task per
 *     comment, agent first-assignment needs an explicit scope confirmation
 *   - read model: the task card under each comment and the agents already
 *     assigned in a doc
 */
import getPrisma from "@/lib/db"
import { createDocCommentCore, deleteDocCommentCore, type CommentAnchorFields } from "@/lib/doc-comments"
import { mentionRoles, uniqueMentions, type MentionRef } from "@/lib/comment-mentions"
import { eligibleTaskAssignees, resolveTaskAssignees } from "@/lib/task-assignment"
import { createWorkspaceTask } from "@/lib/task-create"
import { startRunForAssignedTask, type AgentRunOutcome } from "@/lib/agent-task-trigger"
import { displayIdFromRow } from "@/lib/work-item-ids"
import { runAfterCommit } from "@/lib/following-commit"
import { autoFollow } from "@/lib/follows"
import { emitSubjectEvent } from "@/lib/notifications"
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import type { TaskPriority, TaskStatus } from "@/lib/types"
import type { DocComment } from "@prisma/client"

// ─── Mention candidates ──────────────────────────────────────────────────────

export interface MentionCandidate {
  kind: "user" | "agent"
  id: string
  name: string
  /** Email for people, description for agents. */
  detail: string | null
  /** True for org members with no access to this workspace: mentionable, never assignable. */
  outsideWorkspace?: boolean
  /** Agents only: the access level of their active grant in this workspace. */
  access?: "READ" | "WRITE"
  /** Agents only: CLOUD agents run when assigned; EXTERNAL ones are queued. */
  agentKind?: "EXTERNAL" | "CLOUD"
}

export interface MentionCandidates {
  people: MentionCandidate[]
  agents: MentionCandidate[]
  outside: MentionCandidate[]
}

export async function loadMentionCandidates(workspaceId: string): Promise<MentionCandidates> {
  const prisma = getPrisma()
  const eligible = await eligibleTaskAssignees(workspaceId)
  const userIds = eligible.filter(a => a.type === "USER").map(a => a.id)
  const agentIds = eligible.filter(a => a.type === "AGENT").map(a => a.id)

  const [users, agents, grants, workspace] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, description: true } }) : [],
    agentIds.length ? prisma.agentWorkspaceGrant.findMany({ where: { workspaceId, agentId: { in: agentIds }, revokedAt: null }, select: { agentId: true, access: true } }) : [],
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } }),
  ])
  const access = new Map(grants.map(g => [g.agentId, g.access === "WRITE" ? ("WRITE" as const) : ("READ" as const)]))
  const email = new Map(users.map(u => [u.id, u.email]))
  const description = new Map(agents.map(a => [a.id, a.description]))

  const members = new Set(userIds)
  const orgMembers = workspace
    ? await prisma.organizationMember.findMany({ where: { organizationId: workspace.organizationId }, include: { user: { select: { id: true, name: true, email: true } } } })
    : []

  return {
    people: eligible.filter(a => a.type === "USER").map(a => ({ kind: "user", id: a.id, name: a.displayName, detail: email.get(a.id) ?? null })),
    agents: eligible.filter(a => a.type === "AGENT").map(a => ({ kind: "agent", id: a.id, name: a.displayName, detail: description.get(a.id) ?? null, access: access.get(a.id), agentKind: a.agentKind })),
    outside: orgMembers
      .filter(m => !members.has(m.userId))
      .map(m => ({ kind: "user" as const, id: m.userId, name: m.user.name?.trim() || m.user.email, detail: m.user.email, outsideWorkspace: true })),
  }
}

// ─── Read model ──────────────────────────────────────────────────────────────

export function toCard(task: {
  id: string; seqPrefix: string | null; seqNumber: number | null; title: string; status: string; priority: string; dueDate: Date | null
  assignee: CommentTaskCardData["assignee"]
}): CommentTaskCardData {
  return {
    taskId: task.id,
    displayId: displayIdFromRow("task", task),
    title: task.title,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    assignee: task.assignee,
  }
}

/** Task card per comment id (one task per comment; the earliest link wins if data ever has more). */
export async function loadCommentTaskCards(workspaceId: string, commentIds: string[]): Promise<Record<string, CommentTaskCardData>> {
  if (commentIds.length === 0) return {}
  // Stays on task_links (not the TASK read flip): COMMENT links are legacy-only by design and never mirrored to entity_links.
  const links = await getPrisma().taskLink.findMany({
    where: { linkedType: "COMMENT", linkedId: { in: commentIds }, task: { workspaceId } },
    include: { task: true },
    orderBy: { createdAt: "asc" },
  })
  const tasks = await resolveTaskAssignees(workspaceId, links.map(link => link.task))
  const byTask = new Map(tasks.map(task => [task.id, task]))
  const cards: Record<string, CommentTaskCardData> = {}
  for (const link of links) {
    if (cards[link.linkedId]) continue
    const task = byTask.get(link.taskId)
    if (task) cards[link.linkedId] = toCard({ ...task, assignee: task.assignee ? { type: task.assignee.type, id: task.assignee.id, displayName: task.assignee.displayName, available: task.assignee.available, agentKind: task.assignee.agentKind } : null })
  }
  await restoreLastKnownNames(Object.values(cards))
  return cards
}

/**
 * An assignee who left the workspace (or an agent that lost its grant) resolves to a placeholder name. The card
 * keeps their last known name, looked up on the User / Agent row, next to the "Unavailable" cue.
 */
async function restoreLastKnownNames(cards: CommentTaskCardData[]): Promise<void> {
  const gone = cards.flatMap(card => (card.assignee && !card.assignee.available ? [card.assignee] : []))
  if (gone.length === 0) return
  const prisma = getPrisma()
  const userIds = gone.filter(a => a.type === "USER").map(a => a.id)
  const agentIds = gone.filter(a => a.type === "AGENT").map(a => a.id)
  const [users, agents] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [],
  ])
  const names = new Map<string, string>([
    ...users.map(u => [u.id, u.name?.trim() || u.email] as [string, string]),
    ...agents.map(a => [a.id, a.name] as [string, string]),
  ])
  for (const assignee of gone) {
    const name = names.get(assignee.id)
    if (name) assignee.displayName = name
  }
}

/** Agent ids that already hold a task created from a comment in this doc (the scope-confirm step is skipped for them). */
export async function agentIdsAssignedInDoc(workspaceId: string, docId: string): Promise<string[]> {
  const prisma = getPrisma()
  const commentIds = (await prisma.docComment.findMany({ where: { docId }, select: { id: true } })).map(c => c.id)
  if (commentIds.length === 0) return []
  const tasks = await prisma.task.findMany({
    where: { workspaceId, assigneeAgentId: { not: null }, links: { some: { linkedType: "COMMENT", linkedId: { in: commentIds } } } },
    select: { assigneeAgentId: true },
  })
  return [...new Set(tasks.flatMap(t => (t.assigneeAgentId ? [t.assigneeAgentId] : [])))]
}

// ─── Posting ─────────────────────────────────────────────────────────────────

export interface CommentTaskRequest {
  title: string
  /** YYYY-MM-DD or null. */
  dueDate?: string | null
  priority?: TaskPriority
}

export interface PostCommentInput extends CommentAnchorFields {
  docId: string
  userId: string
  userName: string
  body: string
  parentId?: string | null
  /** Present = create a task from this comment. Absent = plain comment (mentions still notify). */
  task?: CommentTaskRequest | null
  /** Make this mention the assignee instead of the first one. */
  assignee?: { kind: "user" | "agent"; id: string } | null
  /** The person saw the agent scope summary for the first assignment of this agent in this doc. */
  agentScopeConfirmed?: boolean
}

export type PostCommentError =
  | "DOC_NOT_FOUND"
  | "FORBIDDEN"
  | "EMPTY_BODY"
  | "EMPTY_TITLE"
  | "INVALID_PRIORITY"
  | "INVALID_DUE_DATE"
  | "NO_ASSIGNEE"
  | "ASSIGNEE_NOT_IN_WORKSPACE"
  | "AGENT_SCOPE_CONFIRMATION_REQUIRED"
  | "TASK_FAILED"
  | "PARENT_NOT_FOUND"
  | "PARENT_IS_REPLY"

export type PostCommentResult =
  | { ok: true; comment: DocComment; card: CommentTaskCardData | null; mentioned: { assignee: MentionRef | null; watchers: MentionRef[] }; agentRun?: AgentRunOutcome }
  | { ok: false; error: PostCommentError; message?: string }

const PRIORITIES: readonly string[] = ["URGENT", "HIGH", "MEDIUM", "LOW"]

/** A real calendar date as YYYY-MM-DD ("2026-02-31" is rejected, not rolled over to March). */
export function parseDueDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

/**
 * Validate a comment's task request and resolve who it goes to, before anything is written. Shared by the Doc and
 * the generic (Discussion) comment paths so the rules cannot drift.
 */
export async function planCommentTask(input: {
  workspaceId: string
  task: CommentTaskRequest
  roles: { assignee: MentionRef | null }
  agentScopeConfirmed?: boolean
  /** Agents that already hold a task from a comment on this surface (no scope confirmation needed). */
  knownAgentIds: () => Promise<string[]>
}): Promise<{ ok: true; assignee: { type: "USER" | "AGENT"; id: string } } | { ok: false; error: PostCommentError }> {
  if (!input.task.title.trim()) return { ok: false, error: "EMPTY_TITLE" }
  if (input.task.priority !== undefined && !PRIORITIES.includes(input.task.priority)) return { ok: false, error: "INVALID_PRIORITY" }
  if (input.task.dueDate && !parseDueDate(input.task.dueDate)) return { ok: false, error: "INVALID_DUE_DATE" }
  const wanted = input.roles.assignee
  if (!wanted) return { ok: false, error: "NO_ASSIGNEE" }
  const eligible = await eligibleTaskAssignees(input.workspaceId)
  const wantedType = wanted.kind === "agent" ? "AGENT" : "USER"
  if (!eligible.some(a => a.type === wantedType && a.id === wanted.id)) return { ok: false, error: "ASSIGNEE_NOT_IN_WORKSPACE" }
  if (wantedType === "AGENT" && !input.agentScopeConfirmed && !(await input.knownAgentIds()).includes(wanted.id)) {
    return { ok: false, error: "AGENT_SCOPE_CONFIRMATION_REQUIRED" }
  }
  return { ok: true, assignee: { type: wantedType, id: wanted.id } }
}

export async function postDocCommentWithOptionalTask(input: PostCommentInput): Promise<PostCommentResult> {
  const prisma = getPrisma()
  const body = input.body.trim()
  if (!body) return { ok: false, error: "EMPTY_BODY" }

  const doc = await prisma.doc.findUnique({ where: { id: input.docId }, select: { id: true, workspaceId: true, title: true } })
  if (!doc) return { ok: false, error: "DOC_NOT_FOUND" }
  // A real WorkspaceMember row is the write gate. Org-wide read-only viewers have
  // none, so they can neither comment nor create tasks from a comment.
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: doc.workspaceId, userId: input.userId }, select: { id: true } })
  if (!member) return { ok: false, error: "FORBIDDEN" }

  const roles = mentionRoles(body, input.assignee)
  let assignee: { type: "USER" | "AGENT"; id: string } | null = null

  if (input.task) {
    const plan = await planCommentTask({
      workspaceId: doc.workspaceId, task: input.task, roles, agentScopeConfirmed: input.agentScopeConfirmed,
      knownAgentIds: () => agentIdsAssignedInDoc(doc.workspaceId, doc.id),
    })
    if (!plan.ok) return plan
    assignee = plan.assignee
  }

  const created = await createDocCommentCore({
    docId: doc.id, body, parentId: input.parentId ?? null,
    anchorText: input.anchorText, anchorPrefix: input.anchorPrefix, anchorSuffix: input.anchorSuffix,
    anchorStart: input.anchorStart, anchorEnd: input.anchorEnd,
    authorId: input.userId, authorName: input.userName, authorType: "HUMAN", source: "UI",
  })
  if (!created.ok) return { ok: false, error: created.error }

  let card: CommentTaskCardData | null = null
  let taskId: string | null = null
  if (input.task && assignee) {
    try {
      const dueDate = input.task.dueDate ? parseDueDate(input.task.dueDate) : null
      const anchor = created.comment.anchorText?.replace(/\s+/g, " ").trim()
      const task = await createWorkspaceTask(doc.workspaceId, {
        title: input.task.title.trim().slice(0, 255),
        description: `From a comment${anchor ? ` on “${anchor.length > 140 ? `${anchor.slice(0, 139)}…` : anchor}”` : ""} in the doc “${doc.title}”.`,
        priority: input.task.priority ?? "MEDIUM",
        dueDate,
        assignee,
        // The Comment link carries thread sync; the Doc link lists the task under the doc's linked tasks.
        links: [{ linkedType: "COMMENT", linkedId: created.comment.id }, { linkedType: "DOC", linkedId: doc.id }],
      })
      taskId = task.id
      const [resolved] = await resolveTaskAssignees(doc.workspaceId, [task])
      card = toCard({ ...task, assignee: resolved.assignee ? { type: resolved.assignee.type, id: resolved.assignee.id, displayName: resolved.assignee.displayName, available: resolved.assignee.available, agentKind: resolved.assignee.agentKind } : null })
    } catch (error) {
      // Do not leave a comment that promised a task but has none behind.
      await deleteDocCommentCore(created.comment.id).catch(cleanupError => console.error("[doc-comment-tasks] cleanup failed", cleanupError))
      return { ok: false, error: "TASK_FAILED", message: error instanceof Error ? error.message : "Could not create the task." }
    }
  }

  // The comment mentions a cloud agent as the task's assignee: start its run, with the comment as context. The comment and
  // task are saved either way. A comment edit never reaches this function, so editing one cannot start another run.
  let agentRun: AgentRunOutcome | undefined
  if (taskId && assignee?.type === "AGENT") {
    const outcome = await startRunForAssignedTask({ taskId, actingUserId: input.userId, comment: { id: created.comment.id, docId: doc.id, body } })
    if (outcome.status !== "skipped") agentRun = outcome
  }

  await runAfterCommit(() => notifyMentions({
    workspaceId: doc.workspaceId, subjectType: "DOC", subjectId: doc.id, commentId: created.comment.id, actorId: input.userId,
    taskId, mentions: uniqueMentions(body), taskAssigneeUserId: assignee?.type === "USER" && taskId ? assignee.id : null,
  }))

  return { ok: true, comment: created.comment, card, mentioned: roles, ...(agentRun ? { agentRun } : {}) }
}

/**
 * Tell mentioned people. The task assignee already hears via the ASSIGNED
 * notification, so they are skipped here. Watchers follow the task and are
 * notified; a plain mention follows the doc and is notified. Agents are never
 * followers, so they get nothing here: an agent's notification is the task in
 * its queue. Best-effort: runs after the comment committed and never throws.
 */
export async function notifyMentions(input: {
  workspaceId: string; subjectType: string; subjectId: string; commentId: string; actorId: string
  taskId: string | null; mentions: MentionRef[]; taskAssigneeUserId: string | null
}): Promise<void> {
  const users = input.mentions.filter(m => m.kind === "user" && m.id !== input.actorId)
  const recipients = users.filter(m => m.id !== input.taskAssigneeUserId)
  if (recipients.length === 0) return
  for (const mention of recipients) {
    await autoFollow({ userId: mention.id, workspaceId: input.workspaceId, subjectType: input.subjectType, subjectId: input.subjectId, source: "AUTO_MENTION" })
    if (input.taskId) await autoFollow({ userId: mention.id, workspaceId: input.workspaceId, subjectType: "TASK", subjectId: input.taskId, source: "AUTO_MENTION" })
  }
  await emitSubjectEvent({
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    kind: "MENTIONED",
    actor: { type: "USER", id: input.actorId },
    payload: { commentId: input.commentId },
    recipientUserIds: recipients.map(m => m.id),
    dedupeKey: `mention:${input.commentId}`,
  })
}
