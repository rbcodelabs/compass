import { NextRequest, NextResponse } from "next/server"
import { COMMENT_TARGET_TYPES, createComment, type CommentTargetType, type ElementAnchorInput } from "@/lib/comments"
import { authorizeCommentTarget, CommentHttpError, listBrowserComments, toCommentDto, toCommentThreads } from "@/lib/comment-browser"
import { agentIdsAssignedOnTarget, postTargetCommentWithOptionalTask, targetTitle } from "@/lib/comment-target-tasks"
import { loadCommentTaskCards, loadMentionCandidates, type CommentTaskRequest } from "@/lib/doc-comment-tasks"
import { parseMentions } from "@/lib/comment-mentions"
import type { TaskPriority } from "@/lib/types"

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

/**
 * Rebuilt field by field, mirroring the embed route's own `fingerprint()`
 * (app/api/embed/comments/route.ts) — the JSON column must not become a
 * caller's arbitrary storage.
 */
function parseElementFingerprint(value: unknown): ElementAnchorInput["elementFingerprint"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const num = (key: string) => (typeof input[key] === "number" && Number.isFinite(input[key]) ? (input[key] as number) : undefined)
  const str = (key: string, max: number) => (typeof input[key] === "string" ? (input[key] as string).slice(0, max) : undefined)
  return {
    tag: str("tag", 40),
    text: str("text", 200),
    rectXRatio: num("rectXRatio"),
    rectYRatio: num("rectYRatio"),
    rectWRatio: num("rectWRatio"),
    rectHRatio: num("rectHRatio"),
  }
}

/**
 * Optional element-anchor payload for a root ARTIFACT comment, from
 * Compass's own native "leave feedback" picker (components/docs/artifact-
 * viewer.tsx) rather than the embed widget. `pageUrl`/`pagePath` describe
 * the Compass page the picker ran on (the parent frame) — never the
 * sandboxed artifact content, which has no navigable location of its own.
 * `screenshotUrl` is deliberately never accepted here: screenshot capture
 * from the native picker is out of scope for this pass, and lib/comments.ts
 * treats that field as evidence a caller must not pass through unvalidated.
 */
function parseElementAnchor(value: unknown): ElementAnchorInput | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) throw new CommentHttpError(400, "elementAnchor must be an object")
  const input = value as Record<string, unknown>
  const slideIndex = parseSlideIndex(input.slideIndex)
  return {
    pageUrl: requireString(input.pageUrl, "elementAnchor.pageUrl"),
    pagePath: requireString(input.pagePath, "elementAnchor.pagePath"),
    elementSelector: optionalString(input.elementSelector, "elementAnchor.elementSelector"),
    elementFingerprint: parseElementFingerprint(input.elementFingerprint),
    ...(slideIndex === null ? {} : { slideIndex }),
  }
}

/** Zero-based slide of a SLIDE_DECK Artifact. Range and kind are checked again in createComment. */
function parseSlideIndex(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new CommentHttpError(400, "elementAnchor.slideIndex must be a non-negative integer")
  return value
}

/** Optional "create a task from this comment" request; the service validates the values. */
function parseTaskRequest(value: unknown): CommentTaskRequest | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw new CommentHttpError(400, "task must be an object")
  const input = value as Record<string, unknown>
  if (typeof input.title !== "string") throw new CommentHttpError(400, "task.title must be a string")
  if (input.dueDate !== undefined && input.dueDate !== null && typeof input.dueDate !== "string") throw new CommentHttpError(400, "task.dueDate must be a string")
  if (input.priority !== undefined && typeof input.priority !== "string") throw new CommentHttpError(400, "task.priority must be a string")
  return { title: input.title, dueDate: (input.dueDate as string | null | undefined) ?? null, priority: input.priority as TaskPriority | undefined }
}

function parseAssignee(value: unknown): { kind: "user" | "agent"; id: string } | null {
  if (value === undefined || value === null) return null
  const input = value as Record<string, unknown>
  if (typeof value !== "object" || (input.kind !== "user" && input.kind !== "agent") || typeof input.id !== "string") throw new CommentHttpError(400, "assignee must be { kind, id }")
  return { kind: input.kind, id: input.id }
}

const POST_ERROR_STATUS: Record<string, number> = { FORBIDDEN: 403, PARENT_NOT_FOUND: 404, COMMENT_FAILED: 500 }

export async function GET(request: NextRequest) {
  try {
    const targetType = parseTargetType(request.nextUrl.searchParams.get("targetType"))
    const targetId = requireString(request.nextUrl.searchParams.get("targetId"), "targetId")
    const actor = await authorizeCommentTarget(targetType, targetId)
    const rows = await listBrowserComments(actor.workspaceId, targetType, targetId)
    // Mention picker options, task cards and known agents ride along so the composer needs no second round trip.
    const [options, taskCards, confirmedAgentIds, title] = await Promise.all([
      loadMentionCandidates(actor.workspaceId),
      loadCommentTaskCards(actor.workspaceId, rows.map((row) => row.id)),
      agentIdsAssignedOnTarget(actor.workspaceId, targetType, targetId),
      targetTitle(actor.workspaceId, targetType, targetId),
    ])
    return NextResponse.json({ items: toCommentThreads(rows, actor), mention: { options, confirmedAgentIds, targetTitle: title }, taskCards })
  } catch (error) { return errorResponse(error) }
}

export async function POST(request: NextRequest) {
  try {
    let input: unknown
    try { input = await request.json() } catch { throw new CommentHttpError(400, "Request body must be valid JSON") }
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CommentHttpError(400, "Request body must be an object")
    const values = input as Record<string, unknown>
    const targetType = parseTargetType(values.targetType)
    const targetId = requireString(values.targetId, "targetId")
    const body = requireString(values.body, "body")
    const parentId = optionalString(values.parentId, "parentId")
    if (values.elementAnchor !== undefined && targetType !== "ARTIFACT") {
      throw new CommentHttpError(400, "elementAnchor is only supported for targetType ARTIFACT")
    }
    if (values.elementAnchor !== undefined && parentId) {
      throw new CommentHttpError(400, "elementAnchor is only supported on a root comment")
    }
    const elementAnchor = parseElementAnchor(values.elementAnchor)
    const task = parseTaskRequest(values.task)
    const assignee = parseAssignee(values.assignee)
    const actor = await authorizeCommentTarget(targetType, targetId)
    if (task || (!elementAnchor && parseMentions(body).length > 0)) {
      const result = await postTargetCommentWithOptionalTask({
        workspaceId: actor.workspaceId, targetType, targetId, userId: actor.userId, userName: actor.name,
        body, parentId, task, assignee, agentScopeConfirmed: values.agentScopeConfirmed === true,
      })
      if (!result.ok) {
        return NextResponse.json({ error: result.message ?? result.error, code: result.error }, { status: POST_ERROR_STATUS[result.error] ?? 422 })
      }
      return NextResponse.json({ ...toCommentDto(result.comment, actor), taskCard: result.card }, { status: 201 })
    }
    const comment = await createComment({
      workspaceId: actor.workspaceId, targetType, targetId, parentId, body,
      authorId: actor.userId, authorName: actor.name, authorType: "HUMAN", source: "UI",
      ...(elementAnchor ? { elementAnchor } : {}),
    })
    if (!comment) throw new CommentHttpError(404, "Not found")
    return NextResponse.json(toCommentDto(comment, actor), { status: 201 })
  } catch (error) { return errorResponse(error) }
}
