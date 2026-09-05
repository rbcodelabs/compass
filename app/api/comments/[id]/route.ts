import { NextRequest, NextResponse } from "next/server"
import { deleteComment, setCommentStatus, updateCommentBody } from "@/lib/comments"
import { authorizeComment, CommentHttpError, toCommentDto } from "@/lib/comment-browser"

type RouteContext = { params: Promise<{ id: string }> }
function errorResponse(error: unknown) {
  if (error instanceof CommentHttpError) return NextResponse.json({ error: error.message }, { status: error.status })
  return NextResponse.json({ error: error instanceof Error ? error.message : "Bad request" }, { status: 400 })
}
async function parseBody(request: NextRequest): Promise<Record<string, unknown>> {
  const input: unknown = await request.json()
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CommentHttpError(400, "Request body must be an object")
  return input as Record<string, unknown>
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const input = await parseBody(request)
    const authorization = await authorizeComment(id)
    let comment
    if (input.action === "edit") {
      if (!authorization.owns && !authorization.admin) throw new CommentHttpError(404, "Not found")
      if (typeof input.body !== "string" || !input.body.trim()) throw new CommentHttpError(400, "body must be a non-empty string")
      comment = await updateCommentBody(id, input.body)
    } else if (input.action === "resolve" || input.action === "reopen") {
      comment = await setCommentStatus(id, input.action === "resolve" ? "RESOLVED" : "OPEN")
    } else throw new CommentHttpError(400, "Invalid action")
    if (!comment) throw new CommentHttpError(404, "Not found")
    return NextResponse.json(toCommentDto(comment, authorization))
  } catch (error) { return errorResponse(error) }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const authorization = await authorizeComment(id)
    if (!authorization.owns && !authorization.admin) throw new CommentHttpError(404, "Not found")
    if (authorization.comment.replyCount > 0) {
      const confirmed = authorization.admin && request.nextUrl.searchParams.get("deleteThread") === "true"
      if (!confirmed) throw new CommentHttpError(409, "Admin confirmation is required to delete a thread with replies.")
    }
    const result = await deleteComment(id)
    if (!result) throw new CommentHttpError(404, "Not found")
    return NextResponse.json(result)
  } catch (error) { return errorResponse(error) }
}
