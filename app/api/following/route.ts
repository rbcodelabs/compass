import { NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { FollowError, followSubject, getFollowState, unfollowSubject, type FollowErrorCode } from "@/lib/follows"
import { followingAvailable } from "@/lib/following-flag"
import { getFollowable, isSubjectTypeActive } from "@/lib/followable"
import { isFollowingCaller, readJsonObject, resolveFollowingCaller } from "@/lib/following-http"

/**
 * The follow button's data source.
 *   GET /api/following?orgSlug&workspaceSlug&subjectType&subjectId
 *     -> { available, following, muted }   (available:false hides the button)
 *   PUT /api/following  { orgSlug, workspaceSlug, subjectType, subjectId, following }
 *     -> the new { available, following, muted }
 * Always the signed-in user's own state; see lib/following-http.ts for auth.
 */
const STATUS_BY_CODE: Record<FollowErrorCode, number> = {
  FOLLOWING_DISABLED: 404,
  UNKNOWN_SUBJECT_TYPE: 400,
  INACTIVE_SUBJECT_TYPE: 404,
  SUBJECT_NOT_FOUND: 404,
  NOT_A_MEMBER: 403,
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const caller = await resolveFollowingCaller(searchParams.get("orgSlug"), searchParams.get("workspaceSlug"))
  if (!isFollowingCaller(caller)) return caller
  const subjectType = searchParams.get("subjectType")
  const subjectId = searchParams.get("subjectId")
  if (!subjectType || !subjectId) return NextResponse.json({ error: "subjectType and subjectId are required" }, { status: 400 })

  const prisma = getPrisma()
  // Off, or this type's slice has not shipped: not an error, the button just stays hidden.
  if (!(await followingAvailable(prisma)) || !isSubjectTypeActive(subjectType)) return NextResponse.json({ available: false })
  const subject = await getFollowable(subjectType)?.resolveWorkspace(subjectId)
  if (!subject || subject.workspaceId !== caller.workspaceId) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const state = await getFollowState(caller.userId, subjectType, subjectId, prisma)
  return NextResponse.json({ available: true, following: state === "FOLLOWING", muted: state === "MUTED" })
}

export async function PUT(req: Request) {
  const body = await readJsonObject(req)
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  const caller = await resolveFollowingCaller(stringOrNull(body.orgSlug), stringOrNull(body.workspaceSlug))
  if (!isFollowingCaller(caller)) return caller
  const { subjectType, subjectId, following } = body
  if (typeof subjectType !== "string" || typeof subjectId !== "string" || typeof following !== "boolean") {
    return NextResponse.json({ error: "subjectType, subjectId and a boolean following are required" }, { status: 400 })
  }
  try {
    const target = { userId: caller.userId, workspaceId: caller.workspaceId, subjectType, subjectId }
    await (following ? followSubject(target) : unfollowSubject(target))
    return NextResponse.json({ available: true, following, muted: !following })
  } catch (error) {
    if (error instanceof FollowError) return NextResponse.json({ error: error.message }, { status: STATUS_BY_CODE[error.code] })
    throw error
  }
}

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null)
