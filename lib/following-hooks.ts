import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { followingAvailable, followingEnabled } from "@/lib/following-flag"
import { runAfterCommit } from "@/lib/following-commit"
import { getMcpActor } from "@/lib/mcp-authz"
import { autoFollow, type AutoFollowSource, type FollowTarget } from "@/lib/follows"
import { getFollowable, isSubjectTypeActive, type FollowableSubjectType } from "@/lib/followable"
import { emitSubjectEvent, type NotificationActorType, type SubjectEvent } from "@/lib/notifications"
import type { FieldTransition } from "@/lib/status-transitions"

/**
 * The glue between mutation sites and the following core (ADR sections 2.5 and
 * 7, slice 2). Mutation code detects what happened, `buildFollowingEffects`
 * turns that into a flat list of follow and emit effects, and
 * `applyFollowingEffects` runs them after the source mutation has committed.
 * Splitting "what should happen" (pure, tested without a database) from "do it"
 * keeps the transaction free of notification writes, as the ADR requires.
 */
export type FollowActor = { type: NotificationActorType; id: string | null }

export type FollowingEffect =
  | { type: "follow"; target: FollowTarget; source: AutoFollowSource }
  | { type: "emit"; event: SubjectEvent }

/** Adapter models that are follow subjects. evidence and experimentResult are deliberately absent. */
const MODEL_SUBJECT_TYPE: Record<string, FollowableSubjectType | undefined> = {
  task: "TASK",
  doc: "DOC",
  opportunity: "OPPORTUNITY",
  solution: "SOLUTION",
  assumption: "ASSUMPTION",
  roadmapItem: "ROADMAP_ITEM",
  experiment: "EXPERIMENT",
}

export function followSubjectTypeForModel(model: string): FollowableSubjectType | null {
  return MODEL_SUBJECT_TYPE[model] ?? null
}

/** True when the adapter should do any following work for this model right now (no I/O). */
export function followingTracksModel(model: string): boolean {
  const type = followSubjectTypeForModel(model)
  return type !== null && isSubjectTypeActive(type)
}

/** The slice of a mutated row the planner reads. Anything a result omits says nothing about that field. */
export type FollowRow = {
  id?: string
  status?: string
  horizon?: string
  updatedAt?: Date | string | null
  assigneeUserId?: string | null
  assigneeAgentId?: string | null
}
type Row = FollowRow & { id: string }

/**
 * Idempotency key for a status change. Without the Updates flag there is no
 * event id or revision to key on (spike finding 2), so it hashes subject, from,
 * to and the row's `updatedAt`. A replay of the same write collides; a later
 * change back to the same status has a new `updatedAt` and does not.
 */
export function statusDedupeKey(subjectType: string, subjectId: string, from: string | null | undefined, to: string, updatedAt: Date | string | null | undefined): string {
  const stamp = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? "")
  const digest = createHash("sha256").update([subjectType, subjectId, from ?? "", to, stamp].join("|")).digest("hex").slice(0, 40)
  return `status:${digest}`
}

function assignedDedupeKey(subjectId: string, assigneeUserId: string, updatedAt: Row["updatedAt"]): string {
  const stamp = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? "")
  return `assigned:${createHash("sha256").update([subjectId, assigneeUserId, stamp].join("|")).digest("hex").slice(0, 40)}`
}

export type BuildEffectsInput = {
  model: string
  operation: "create" | "update"
  before: FollowRow | null
  after: Row
  actor: FollowActor
  transitions: FieldTransition[]
  /** Called only when there is at least one effect, so no-op writes cost no extra read. */
  workspaceId: () => Promise<string>
}

export async function buildFollowingEffects(input: BuildEffectsInput): Promise<FollowingEffect[]> {
  const subjectType = followSubjectTypeForModel(input.model)
  if (!subjectType || !isSubjectTypeActive(subjectType)) return []
  const definition = getFollowable(subjectType)
  if (!definition) return []
  const { after, actor } = input

  // Agents, system writes and external authors never follow. A USER actor is a
  // Compass user, including an MCP caller using their own credential.
  const creator = input.operation === "create" && actor.type === "USER" && actor.id ? actor.id : null
  const statusChanges = input.operation === "update" && definition.emitsStatus ? input.transitions.filter((t) => t.field === "status") : []
  const assignee = definition.emitsAssignment && after.assigneeUserId !== undefined && after.assigneeUserId ? after.assigneeUserId : null
  const newlyAssigned = assignee !== null && assignee !== (input.before?.assigneeUserId ?? null) ? assignee : null

  if (!creator && statusChanges.length === 0 && !newlyAssigned) return []
  const workspaceId = await input.workspaceId()
  const effects: FollowingEffect[] = []
  const target = (userId: string): FollowTarget => ({ userId, workspaceId, subjectType, subjectId: after.id })

  if (creator) effects.push({ type: "follow", target: target(creator), source: "AUTO_CREATE" })
  for (const change of statusChanges) {
    effects.push({
      type: "emit",
      event: {
        workspaceId, subjectType, subjectId: after.id, kind: "STATUS_CHANGED", actor,
        payload: { from: change.from ?? null, to: change.to },
        dedupeKey: statusDedupeKey(subjectType, after.id, change.from, change.to, after.updatedAt),
      },
    })
  }
  if (newlyAssigned) {
    effects.push({ type: "follow", target: target(newlyAssigned), source: "AUTO_ASSIGN" })
    effects.push({
      type: "emit",
      event: {
        workspaceId, subjectType, subjectId: after.id, kind: "ASSIGNED", actor,
        payload: { to: newlyAssigned },
        // Only the assignee hears about it. The emitter still drops the actor, so
        // assigning a task to yourself follows it without notifying you.
        recipientUserIds: [newlyAssigned],
        dedupeKey: assignedDedupeKey(after.id, newlyAssigned, after.updatedAt),
      },
    })
  }
  return effects
}

// ─── Actors ──────────────────────────────────────────────────────────────────

/** The ambient MCP credential as a notification actor, or null outside an MCP request. */
export function mcpFollowActor(): FollowActor | null {
  try {
    const actor = getMcpActor()
    if ((actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") && actor.agentId) return { type: "AGENT", id: actor.agentId }
    if ((!actor.purpose || actor.purpose === "USER") && actor.userId) return { type: "USER", id: actor.userId }
    return { type: "SYSTEM", id: null }
  } catch {
    return null
  }
}

/** The signed-in user of a server action, or SYSTEM when there is no session. Never throws. */
export async function sessionFollowActor(): Promise<FollowActor> {
  try {
    const { auth } = await import("@/auth")
    const session = await auth()
    if (session?.user?.id) return { type: "USER", id: session.user.id }
  } catch {
    // fall through
  }
  return { type: "SYSTEM", id: null }
}

// ─── Creation outside the status adapter (Docs, decision follow-up Tasks) ───

/**
 * Auto-follow for a subject created at a site that does not go through
 * `captureWorkspaceMutation` (Docs have no status, and the decision follow-up
 * Task is written in its own transaction). Same gates as the adapter, same
 * post-commit delivery, never throws.
 */
export async function followAfterCreate(input: {
  model: string
  workspaceId: string
  row: FollowRow & { id: string }
  /** A function is resolved only once following is known to be active, so a disabled feature costs no auth() call. */
  actor: FollowActor | (() => Promise<FollowActor>)
}): Promise<void> {
  try {
    if (!followingEnabled() || !followingTracksModel(input.model)) return
    if (!(await followingAvailable(getPrisma()))) return
    const actor = typeof input.actor === "function" ? await input.actor() : input.actor
    const effects = await buildFollowingEffects({
      model: input.model, operation: "create", before: null, after: input.row, actor,
      transitions: [], workspaceId: async () => input.workspaceId,
    })
    if (effects.length > 0) await runAfterCommit(() => applyFollowingEffects(effects))
  } catch (error) {
    console.error("[following] create hook failed", error)
  }
}

// ─── Comments ────────────────────────────────────────────────────────────────

export type CommentActorInput = {
  source?: string
  authorId?: string | null
  authorType?: string
  externalAuthor?: unknown
}

/**
 * Who wrote a comment, as a notification actor. Portal and embed visitors are
 * EXTERNAL with no id (their email never enters a notification). An MCP caller is
 * whatever the credential resolves to: a user's own key is that USER, an
 * agent-scoped token is the AGENT. Agents are never followers either way.
 */
export function resolveCommentFollowActor(input: CommentActorInput): FollowActor {
  if (input.externalAuthor) return { type: "EXTERNAL", id: null }
  if (input.source === "MCP") {
    const actor = mcpFollowActor()
    if (actor) return actor
    // No MCP context (a scripted call): fall through to the author fields.
  }
  if (input.authorId && input.authorType !== "AGENT") return { type: "USER", id: input.authorId }
  if (input.source === "WIDGET") return { type: "EXTERNAL", id: null }
  return { type: "SYSTEM", id: null }
}

export type CommentEffectsInput = {
  workspaceId: string
  targetType: string
  targetId: string
  commentId: string
  parentId?: string | null
  source?: string
  actor: FollowActor
}

/**
 * Effects for one new comment (ADR 2.5): follow the human commenter, and tell the
 * subject's followers. Replies notify too (`COMMENT_REPLIED`); the Updates feed
 * skips them but an inbox should not. Migration imports are history, not news.
 */
export function buildCommentEffects(input: CommentEffectsInput): FollowingEffect[] {
  if (input.source === "MIGRATION") return []
  if (!isSubjectTypeActive(input.targetType)) return []
  const effects: FollowingEffect[] = []
  if (input.actor.type === "USER" && input.actor.id) {
    effects.push({
      type: "follow",
      target: { userId: input.actor.id, workspaceId: input.workspaceId, subjectType: input.targetType, subjectId: input.targetId },
      source: "AUTO_COMMENT",
    })
  }
  effects.push({
    type: "emit",
    event: {
      workspaceId: input.workspaceId,
      subjectType: input.targetType,
      subjectId: input.targetId,
      kind: input.parentId ? "COMMENT_REPLIED" : "COMMENT_ADDED",
      actor: input.actor,
      payload: { commentId: input.commentId, parentCommentId: input.parentId ?? null },
      dedupeKey: `comment:${input.commentId}`,
    },
  })
  return effects
}

/** Runs effects in order. autoFollow and emitSubjectEvent never throw; the guard covers anything else. */
export async function applyFollowingEffects(effects: FollowingEffect[]): Promise<void> {
  for (const effect of effects) {
    try {
      if (effect.type === "follow") await autoFollow({ ...effect.target, source: effect.source })
      else await emitSubjectEvent(effect.event)
    } catch (error) {
      console.error("[following] effect failed", { type: effect.type }, error)
    }
  }
}
