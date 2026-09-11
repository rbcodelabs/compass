import { createComment, deleteComment, getComment, listComments, setCommentStatus, updateCommentBody, type CommentStatus, type CommentTargetType } from "@/lib/comments"
import { fail, ok } from "@/lib/mcp-output"

const shape = (comment: NonNullable<Awaited<ReturnType<typeof getComment>>>) => ({ ...comment, createdAt: comment.createdAt.toISOString(), updatedAt: comment.updatedAt.toISOString() })

export async function addComment(input: { workspaceId: string; targetType: CommentTargetType; targetId: string; parentId?: string; body: string; authorName: string }) {
  const comment = await createComment({ ...input, parentId: input.parentId ?? null, authorType: "AGENT", source: "MCP" })
  if (!comment) return fail("Comment could not be created.")
  const data = shape(comment)
  return ok(`**Comment added**\nTarget: ${input.targetType} ${input.targetId}\nID: ${comment.id}`, data)
}

export async function listCommentsTool(input: { workspaceId: string; targetType: CommentTargetType; targetId: string; status?: CommentStatus }) {
  const comments = await listComments(input.workspaceId, input.targetType, input.targetId, input.status)
  const items = comments.map(shape)
  return ok(`${comments.length} comment${comments.length === 1 ? "" : "s"} on ${input.targetType} ${input.targetId}.`, { items, count: items.length })
}

export async function getCommentTool({ commentId }: { commentId: string }) {
  const comment = await getComment(commentId)
  return comment ? ok(`${comment.body}\nID: ${comment.id}`, shape(comment)) : fail(`Comment "${commentId}" not found.`)
}

export async function updateComment({ commentId, body }: { commentId: string; body: string }) {
  const comment = await updateCommentBody(commentId, body)
  return comment ? ok(`**Comment updated**\nID: ${comment.id}`, shape(comment)) : fail(`Comment "${commentId}" not found.`)
}

export async function deleteCommentTool({ commentId }: { commentId: string }) {
  const result = await deleteComment(commentId)
  return result ? ok(`**Comment deleted**\nID: ${commentId}`, result) : fail(`Comment "${commentId}" not found.`)
}

async function changeStatus(commentId: string, status: CommentStatus) {
  const comment = await setCommentStatus(commentId, status)
  return comment ? ok(`**Comment ${status === "RESOLVED" ? "resolved" : "reopened"}**\nID: ${comment.id}`, shape(comment)) : fail(`Comment "${commentId}" not found.`)
}
export const resolveComment = ({ commentId }: { commentId: string }) => changeStatus(commentId, "RESOLVED")
export const reopenComment = ({ commentId }: { commentId: string }) => changeStatus(commentId, "OPEN")
