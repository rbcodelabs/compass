import getPrisma from "@/lib/db"

export const COMMENT_TARGET_TYPES = [
  "OBJECTIVE", "KEY_RESULT", "OPPORTUNITY", "SOLUTION", "ASSUMPTION",
  "EXPERIMENT", "ROADMAP_ITEM", "FEEDBACK_ITEM", "TASK", "DOC", "ARTIFACT",
  "RESEARCH_STUDY", "REVIEW_REQUEST",
] as const

export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number]
export type CommentStatus = "OPEN" | "RESOLVED"
export type CommentAuthorType = "AGENT" | "HUMAN"
export type CommentSource = "UI" | "MCP" | "MIGRATION"

export type DocAnchorInput = {
  anchorText: string
  anchorPrefix?: string | null
  anchorSuffix?: string | null
  anchorStart?: number | null
  anchorEnd?: number | null
}

export type SolutionPlanInput = {
  trackedDecisionRequestId?: string | null
  legacyPlanStatus?: "PENDING" | "APPROVED" | "REJECTED" | null
}

type CreateCommentInput = {
  id?: string
  workspaceId: string
  targetType: CommentTargetType
  targetId: string
  parentId?: string | null
  body: string
  status?: CommentStatus
  authorId?: string | null
  authorName: string
  authorType?: CommentAuthorType
  source?: CommentSource
  createdAt?: Date
  updatedAt?: Date
  docAnchor?: DocAnchorInput
  solutionPlan?: SolutionPlanInput
}

export async function resolveCommentTarget(targetType: CommentTargetType, targetId: string) {
  const prisma = getPrisma()
  switch (targetType) {
    case "OBJECTIVE": {
      const row = await prisma.objective.findUnique({ where: { id: targetId }, select: { cycle: { select: { workspaceId: true } } } })
      return row ? { workspaceId: row.cycle.workspaceId } : null
    }
    case "KEY_RESULT": {
      const row = await prisma.keyResult.findUnique({ where: { id: targetId }, select: { objective: { select: { cycle: { select: { workspaceId: true } } } } } })
      return row ? { workspaceId: row.objective.cycle.workspaceId } : null
    }
    case "OPPORTUNITY": return prisma.opportunity.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "SOLUTION": {
      const row = await prisma.solution.findUnique({ where: { id: targetId }, select: { opportunity: { select: { workspaceId: true } } } })
      return row ? { workspaceId: row.opportunity.workspaceId } : null
    }
    case "ASSUMPTION": {
      const row = await prisma.assumption.findUnique({ where: { id: targetId }, select: { solution: { select: { opportunity: { select: { workspaceId: true } } } } } })
      return row ? { workspaceId: row.solution.opportunity.workspaceId } : null
    }
    case "EXPERIMENT": return prisma.experiment.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "ROADMAP_ITEM": return prisma.roadmapItem.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "FEEDBACK_ITEM": return prisma.feedbackItem.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "TASK": return prisma.task.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "DOC": return prisma.doc.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "ARTIFACT": return prisma.artifact.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "RESEARCH_STUDY": return prisma.researchStudy.findUnique({ where: { id: targetId }, select: { workspaceId: true } })
    case "REVIEW_REQUEST": {
      const row = await prisma.reviewRequest.findUnique({ where: { id: targetId }, select: { workspaceId: true, gateType: true } })
      return row?.gateType === "TRACKED_DECISION" ? { workspaceId: row.workspaceId } : null
    }
  }
}

function validateExtensions(input: CreateCommentInput) {
  if (input.docAnchor && (input.targetType !== "DOC" || input.parentId)) {
    throw new Error("Anchors are allowed only on root Doc comments.")
  }
  if (input.solutionPlan && (input.targetType !== "SOLUTION" || input.parentId)) {
    throw new Error("Plan proposals are allowed only on root Solution comments.")
  }
  if (input.docAnchor && !input.docAnchor.anchorText.trim()) throw new Error("Anchor text must not be empty.")
}

export async function createComment(input: CreateCommentInput) {
  const prisma = getPrisma()
  const body = input.body.trim()
  if (!body) throw new Error("Comment body must not be empty.")
  validateExtensions(input)

  const target = await resolveCommentTarget(input.targetType, input.targetId)
  if (!target) throw new Error(`${input.targetType} target not found or not commentable.`)
  if (target.workspaceId !== input.workspaceId) throw new Error("Comment target does not belong to the declared workspace.")

  if (input.parentId) {
    const parent = await prisma.comment.findUnique({ where: { id: input.parentId }, select: { id: true, workspaceId: true, targetType: true, targetId: true, parentId: true } })
    if (!parent || parent.workspaceId !== input.workspaceId || parent.targetType !== input.targetType || parent.targetId !== input.targetId) {
      throw new Error("Parent comment must share the exact workspace and target.")
    }
    if (parent.parentId) throw new Error("Comment threads are only one level deep.")
  }

  const comment = await prisma.comment.create({
    data: {
      ...(input.id ? { id: input.id } : {}), workspaceId: input.workspaceId,
      targetType: input.targetType, targetId: input.targetId, parentId: input.parentId ?? null,
      body, status: input.status ?? "OPEN", authorId: input.authorId ?? null,
      authorName: input.authorName, authorType: input.authorType ?? "HUMAN",
      source: input.source ?? "UI", ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    },
  })
  try {
    if (input.docAnchor) await prisma.docCommentAnchor.create({ data: { commentId: comment.id, ...input.docAnchor } })
    if (input.solutionPlan) await prisma.solutionPlanProposal.create({ data: { commentId: comment.id, trackedDecisionRequestId: input.solutionPlan.trackedDecisionRequestId ?? null, legacyPlanStatus: input.solutionPlan.legacyPlanStatus ?? null } })
  } catch (error) {
    await prisma.comment.delete({ where: { id: comment.id } })
    throw error
  }
  return getComment(comment.id)
}

export function listComments(workspaceId: string, targetType: CommentTargetType, targetId: string, status?: CommentStatus) {
  return getPrisma().comment.findMany({
    where: { workspaceId, targetType, targetId, ...(status ? { status } : {}) },
    include: { docAnchor: true, solutionPlanProposal: true }, orderBy: { createdAt: "asc" },
  })
}

export function getComment(commentId: string) {
  return getPrisma().comment.findUnique({ where: { id: commentId }, include: { docAnchor: true, solutionPlanProposal: true } })
}

export async function updateCommentBody(commentId: string, body: string) {
  const prisma = getPrisma(); const trimmed = body.trim()
  if (!trimmed) throw new Error("Comment body must not be empty.")
  if (!await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })) return null
  await prisma.comment.update({ where: { id: commentId }, data: { body: trimmed, updatedAt: new Date() } })
  return getComment(commentId)
}

export async function setCommentStatus(commentId: string, status: CommentStatus) {
  const prisma = getPrisma()
  if (!await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })) return null
  await prisma.comment.update({ where: { id: commentId }, data: { status, updatedAt: new Date() } })
  return getComment(commentId)
}

export async function deleteComment(commentId: string) {
  const prisma = getPrisma()
  const existing = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true, parentId: true } })
  if (!existing) return null
  const replies = existing.parentId ? [] : await prisma.comment.findMany({ where: { parentId: commentId }, select: { id: true } })
  const ids = [...replies.map((reply) => reply.id), commentId]
  await prisma.docCommentAnchor.deleteMany({ where: { commentId: { in: ids } } })
  await prisma.solutionPlanProposal.deleteMany({ where: { commentId: { in: ids } } })
  if (!existing.parentId) await prisma.comment.deleteMany({ where: { parentId: commentId } })
  await prisma.comment.delete({ where: { id: commentId } })
  return { id: commentId, deletedReplies: replies.length }
}
