import { NextRequest, NextResponse } from "next/server"
import { ShareCommentError, commenterCookieName, createShareComment, listOwnShareComments, verifyCommenter } from "@/lib/artifact-share-comments"
import { jsonError, requireCommentingShare, sameOriginOrNull } from "../_guard"

async function requireCommenter(request: NextRequest, token: string) {
  const share = await requireCommentingShare(request, token)
  const commenter = await verifyCommenter(share, request.cookies.get(commenterCookieName(token))?.value)
  if (!commenter) throw new ShareCommentError(401, "Confirm your email to comment.")
  return { share, commenter }
}

/** The signed-in viewer's OWN comments only. Never internal comments, replies, pins, or other outsiders'. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const { share, commenter } = await requireCommenter(request, token)
    return NextResponse.json({ email: commenter.email, comments: await listOwnShareComments(share, commenter) })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const blocked = sameOriginOrNull(request)
  if (blocked) return blocked
  try {
    const { token } = await params
    const { share, commenter } = await requireCommenter(request, token)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }
    const input = (body ?? {}) as { body?: unknown; parentId?: unknown }
    return NextResponse.json({ comment: await createShareComment(share, commenter, input) }, { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
