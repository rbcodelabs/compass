import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import type { CommentTargetType } from "@/lib/comments"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

/**
 * The subject registry for Following and in-app notifications (ADR "Following
 * and in-app notifications", section 2.3). Follow and Notification rows are
 * polymorphic (subjectType + subjectId) and Aurora DSQL enforces no foreign
 * keys, so every per-type fact lives in this one table: how to find a subject's
 * workspace, how to label it, who may see it, which slice ships it, and which
 * events it can emit.
 *
 * The vocabulary is exactly COMMENT_TARGET_TYPES plus METRIC, so the comment
 * hook needs no mapping between "comment target" and "follow subject". The list
 * is written out here, not imported, because lib/comments.ts will import the
 * notification emitter and a value import back would create a cycle that breaks
 * the top-level registry below. followable-registry.test.ts pins the two lists
 * together instead.
 */
export const FOLLOWABLE_SUBJECT_TYPES = [
  "OBJECTIVE", "KEY_RESULT", "OPPORTUNITY", "SOLUTION", "ASSUMPTION",
  "EXPERIMENT", "ROADMAP_ITEM", "FEEDBACK_ITEM", "TASK", "DOC", "ARTIFACT",
  "RESEARCH_STUDY", "REVIEW_REQUEST", "METRIC",
] as const
export type FollowableSubjectType = (typeof FOLLOWABLE_SUBJECT_TYPES)[number]

export type SubjectDisplay = {
  title: string
  /** Workspace-relative path, e.g. `tasks/<id>`. The caller prefixes the workspace base URL. */
  path: string
}

/**
 * Which rollout slice makes a type live. Both following and emission are gated
 * on it, so a type a later slice has not wired yet stays silent instead of
 * producing half-covered notifications. "deferred" types are registered (so the
 * vocabulary stays complete) but never become active.
 */
export type FollowableSlice = 2 | 3 | "deferred"

export type FollowableDefinition = {
  slice: FollowableSlice
  emitsStatus: boolean
  emitsComments: boolean
  /** Assignment notifications (ADR open question 4, recommended yes). Tasks only. */
  emitsAssignment: boolean
  /** The owning workspace, or null when the subject is missing or not followable. */
  resolveWorkspace(id: string): Promise<{ workspaceId: string } | null>
  /** Batched display data. A missing or out-of-workspace subject is simply absent from the map. */
  resolveDisplay(workspaceId: string, ids: string[], prisma: AppPrismaClient): Promise<Map<string, SubjectDisplay>>
  /**
   * Extra access rule beyond current WorkspaceMember, when a type has one.
   * Absent means workspace membership is the whole rule.
   */
  canView?(userId: string, subject: { workspaceId: string }): Promise<boolean> | boolean
}

/**
 * Slice 1 ships the infrastructure only, so nothing is active yet. Slice 2 sets
 * this to 2 and slice 3 to 3. A mutable holder rather than a constant so tests
 * can exercise later slices without a build-time switch.
 */
export const followableConfig: { shippedSlice: 1 | 2 | 3 } = { shippedSlice: 1 }

const commentTarget = (type: CommentTargetType) => async (id: string) => {
  // Lazy: lib/comments.ts imports the notification emitter in slice 2.
  const { resolveCommentTarget } = await import("@/lib/comments")
  return resolveCommentTarget(type, id)
}

const display = (rows: { id: string; title: string; path: string }[]) =>
  new Map(rows.map((row) => [row.id, { title: row.title, path: row.path }]))

const definitions: Record<FollowableSubjectType, FollowableDefinition> = {
  OPPORTUNITY: {
    slice: 2, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("OPPORTUNITY"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.opportunity.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `discovery/${r.id}` })))
    },
  },
  SOLUTION: {
    slice: 2, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("SOLUTION"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.solution.findMany({ where: { id: { in: ids }, opportunity: { workspaceId } }, select: { id: true, title: true, opportunityId: true } })
      return display(rows.map((r) => ({ id: r.id, title: r.title, path: `discovery/${r.opportunityId}?detail=solution%3A${r.id}` })))
    },
  },
  TASK: {
    slice: 2, emitsStatus: true, emitsComments: true, emitsAssignment: true,
    resolveWorkspace: commentTarget("TASK"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.task.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `tasks/${r.id}` })))
    },
  },
  // Docs have no lifecycle status in the schema (ADR open question 1), so they
  // notify on comments only and document versions are out of scope.
  DOC: {
    slice: 2, emitsStatus: false, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("DOC"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.doc.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `docs/${r.id}` })))
    },
  },
  ASSUMPTION: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("ASSUMPTION"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.assumption.findMany({
        where: { id: { in: ids }, solution: { opportunity: { workspaceId } } },
        select: { id: true, title: true, solution: { select: { opportunityId: true } } },
      })
      return display(rows.map((r) => ({ id: r.id, title: r.title, path: `discovery/${r.solution.opportunityId}?detail=assumption%3A${r.id}` })))
    },
  },
  EXPERIMENT: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("EXPERIMENT"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.experiment.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `experiments/${r.id}` })))
    },
  },
  ROADMAP_ITEM: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("ROADMAP_ITEM"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.roadmapItem.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `roadmap?detail=roadmapItem%3A${r.id}` })))
    },
  },
  OBJECTIVE: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("OBJECTIVE"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.objective.findMany({ where: { id: { in: ids }, cycle: { workspaceId } }, select: { id: true, title: true, cycleId: true } })
      return display(rows.map((r) => ({ id: r.id, title: r.title, path: `okrs/${r.cycleId}` })))
    },
  },
  // Key results have no status column (progress is a numeric check-in), so they
  // notify on comments only.
  KEY_RESULT: {
    slice: 3, emitsStatus: false, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("KEY_RESULT"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.keyResult.findMany({
        where: { id: { in: ids }, objective: { cycle: { workspaceId } } },
        select: { id: true, title: true, objective: { select: { cycleId: true } } },
      })
      return display(rows.map((r) => ({ id: r.id, title: r.title, path: `okrs/${r.objective.cycleId}` })))
    },
  },
  FEEDBACK_ITEM: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("FEEDBACK_ITEM"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.feedbackItem.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: "feedback" })))
    },
  },
  // A tracked Decision is a ReviewRequest with gateType TRACKED_DECISION.
  REVIEW_REQUEST: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("REVIEW_REQUEST"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.reviewRequest.findMany({
        where: { workspaceId, id: { in: ids }, gateType: "TRACKED_DECISION" },
        select: { id: true, currentRevision: { select: { title: true } } },
      })
      return display(rows.flatMap((r) => (r.currentRevision ? [{ id: r.id, title: r.currentRevision.title, path: `reviews/${r.id}` }] : [])))
    },
  },
  RESEARCH_STUDY: {
    slice: 3, emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("RESEARCH_STUDY"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.researchStudy.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, name: true } })
      return display(rows.map((r) => ({ id: r.id, title: r.name, path: `capture/studies/${r.id}` })))
    },
    // The study page is behind both workspace membership and the research
    // capture feature. lib/research-access.ts only resolves participant-token
    // access and has no per-user check to delegate to.
    canView: () => isResearchCaptureEnabled(),
  },
  // Artifacts are commentable and status-bearing but were not in the product
  // owner's list (ADR open question 3, no recommendation). Registered so the
  // vocabulary is complete; never active until someone decides.
  ARTIFACT: {
    slice: "deferred", emitsStatus: true, emitsComments: true, emitsAssignment: false,
    resolveWorkspace: commentTarget("ARTIFACT"),
    async resolveDisplay(workspaceId, ids, prisma) {
      const rows = await prisma.artifact.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, title: true } })
      return display(rows.map((r) => ({ ...r, path: `docs/artifacts/${r.id}` })))
    },
  },
  // Metrics are not commentable, so a Metric follow can only ever notify on
  // status (archive). Held in slice 3 so it can be dropped with one edit if the
  // product decides that is not worth shipping (ADR open question 2).
  METRIC: {
    slice: 3, emitsStatus: true, emitsComments: false, emitsAssignment: false,
    async resolveWorkspace(id) {
      return getPrisma().metricDefinition.findUnique({ where: { id }, select: { workspaceId: true } })
    },
    async resolveDisplay(workspaceId, ids, prisma) {
      const definitionsRows = await prisma.metricDefinition.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, currentRevisionId: true } })
      const revisions = await prisma.metricRevision.findMany({
        where: { workspaceId, id: { in: definitionsRows.map((d) => d.currentRevisionId) } },
        select: { id: true, name: true },
      })
      const names = new Map(revisions.map((r) => [r.id, r.name]))
      return display(definitionsRows.flatMap((d) => {
        const name = names.get(d.currentRevisionId)
        return name ? [{ id: d.id, title: name, path: "metrics" }] : []
      }))
    },
  },
}

export function getFollowable(type: string): FollowableDefinition | null {
  return (FOLLOWABLE_SUBJECT_TYPES as readonly string[]).includes(type) ? definitions[type as FollowableSubjectType] : null
}

export function listFollowableTypes(): FollowableSubjectType[] {
  return [...FOLLOWABLE_SUBJECT_TYPES]
}

export function isFollowableType(type: string): type is FollowableSubjectType {
  return getFollowable(type) !== null
}

/** True when the type's slice has shipped. Gates follow creation, emission and listing alike. */
export function isSubjectTypeActive(type: string): boolean {
  const def = getFollowable(type)
  return def !== null && def.slice !== "deferred" && def.slice <= followableConfig.shippedSlice
}

/**
 * The type's own access rule only, for a caller who has already been verified as
 * a current workspace member. True when the type has no extra rule.
 */
export async function passesTypeAccessRule(type: string, userId: string, workspaceId: string): Promise<boolean> {
  const def = getFollowable(type)
  if (!def) return false
  return def.canView ? Boolean(await def.canView(userId, { workspaceId })) : true
}

/**
 * Subset of `userIds` allowed to see a subject of this type in this workspace:
 * current WorkspaceMember first (one batched query), then the type's own extra
 * rule if it has one. Used at emit time so ex-members never get new rows.
 */
export async function viewerIdsFor(type: string, workspaceId: string, userIds: string[], prisma: AppPrismaClient = getPrisma()): Promise<string[]> {
  if (!getFollowable(type) || userIds.length === 0) return []
  const members = await prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: userIds } }, select: { userId: true } })
  const memberIds = new Set(members.map((m) => m.userId))
  const candidates = userIds.filter((id) => memberIds.has(id))
  const allowed = await Promise.all(candidates.map(async (id) => ((await passesTypeAccessRule(type, id, workspaceId)) ? id : null)))
  return allowed.filter((id): id is string => id !== null)
}
