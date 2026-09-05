import { NextRequest, NextResponse } from "next/server"
import { COMMENT_TARGET_TYPES, createComment, type CommentTargetType } from "@/lib/comments"
import { authorizeCommentTarget, CommentHttpError, listBrowserComments, toCommentDto, toCommentThreads } from "@/lib/comment-browser"

function errorResponse(error: unknown) {
  if (error instanceof CommentHttpError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error("Unexpected comments route error", error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}
function parseTargetType(value: unknown): CommentTargetType {
  if (typeof value !== "string" || !COMMENT_TARGET_TYPES.some((type) => type === value)) throw new CommentHttpError(400, "Invalid targetType")
  return value as CommentTargetType
}
function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new CommentHttpError(400, `${field} must be a non-empty string`)
  return value
}
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value.trim()) throw new CommentHttpError(400, `${field} must be a non-empty string when provided`)
  return value
}

export async function GET(request: NextRequest) {
  try {
    const targetType = parseTargetType(request.nextUrl.searchParams.get("targetType"))
    const targetId = requireString(request.nextUrl.searchParams.get("targetId"), "targetId")
    const actor = await authorizeCommentTarget(targetType, targetId)
    return NextResponse.json({ items: toCommentThreads(await listBrowserComments(actor.workspaceId, targetType, targetId), actor) })
  } catch (error) { return errorResponse(error) }
}

export async function POST(request: NextRequest) {
  try {
    const input: unknown = await request.json()
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CommentHttpError(400, "Request body must be an object")
    const values = input as Record<string, unknown>
    const targetType = parseTargetType(values.targetType)
    const targetId = requireString(values.targetId, "targetId")
    const body = requireString(values.body, "body")
    const parentId = optionalString(values.parentId, "parentId")
    const actor = await authorizeCommentTarget(targetType, targetId)
    const comment = await createComment({ workspaceId: actor.workspaceId, targetType, targetId, parentId, body, authorId: actor.userId, authorName: actor.name, authorType: "HUMAN", source: "UI" })
    if (!comment) throw new CommentHttpError(404, "Not found")
    return NextResponse.json(toCommentDto(comment, actor), { status: 201 })
  } catch (error) { return errorResponse(error) }
}
