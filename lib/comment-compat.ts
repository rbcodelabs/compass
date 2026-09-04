import type { DocComment, SolutionComment } from "@prisma/client"
import { createComment, deleteComment, getComment, setCommentStatus, updateCommentBody } from "@/lib/comments"
import getPrisma from "@/lib/db"

export async function mirrorLegacyDocComment(comment: DocComment) {
  const workspace = await getPrisma().doc.findUnique({ where: { id: comment.docId }, select: { workspaceId: true } })
  if (!workspace) throw new Error("Doc not found while mirroring comment.")
  return createComment({
    id: comment.id, workspaceId: workspace.workspaceId, targetType: "DOC", targetId: comment.docId,
    parentId: comment.parentId, body: comment.body, status: comment.status as "OPEN" | "RESOLVED",
    authorId: comment.authorId, authorName: comment.authorName,
    authorType: comment.authorType as "AGENT" | "HUMAN", source: comment.source as "UI" | "MCP",
    createdAt: comment.createdAt, updatedAt: comment.updatedAt,
    ...(comment.anchorText ? { docAnchor: { anchorText: comment.anchorText, anchorPrefix: comment.anchorPrefix, anchorSuffix: comment.anchorSuffix, anchorStart: comment.anchorStart, anchorEnd: comment.anchorEnd } } : {}),
  })
}

export async function mirrorLegacySolutionComment(comment: SolutionComment) {
  const solution = await getPrisma().solution.findUnique({ where: { id: comment.solutionId }, select: { opportunity: { select: { workspaceId: true } } } })
  if (!solution) throw new Error("Solution not found while mirroring comment.")
  return createComment({
    id: comment.id, workspaceId: solution.opportunity.workspaceId, targetType: "SOLUTION", targetId: comment.solutionId,
    body: comment.body, authorName: comment.authorName, authorType: comment.authorType as "AGENT" | "HUMAN",
    source: comment.source as "UI" | "MCP", createdAt: comment.createdAt, updatedAt: comment.updatedAt,
    ...(comment.commentType === "PLAN" ? { solutionPlan: { legacyPlanStatus: comment.planStatus as "PENDING" | "APPROVED" | "REJECTED" } } : {}),
  })
}

export async function updateMirroredComment(id: string, body: string) {
  if (await getComment(id)) await updateCommentBody(id, body)
}

export async function updateMirroredDocStatus(id: string, status: "OPEN" | "RESOLVED") {
  if (await getComment(id)) await setCommentStatus(id, status)
}

export async function updateMirroredLegacyPlanStatus(id: string, status: "PENDING" | "APPROVED" | "REJECTED") {
  const prisma = getPrisma()
  if (await getComment(id)) await prisma.solutionPlanProposal.updateMany({ where: { commentId: id }, data: { legacyPlanStatus: status } })
}

export async function deleteMirroredComment(id: string) {
  if (await getComment(id)) await deleteComment(id)
}
