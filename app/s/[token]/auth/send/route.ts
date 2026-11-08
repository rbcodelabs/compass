import { NextRequest, NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { hashMagicToken, issueMagicToken, parseEmail, sendShareSignInEmail } from "@/lib/artifact-share-comments"
import { jsonError, requireCommentingShare, sameOriginOrNull } from "../../_guard"

/** Emails a one-time link that lets an already-unlocked viewer comment. Same response whether or not a link was sent. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const blocked = sameOriginOrNull(request)
  if (blocked) return blocked
  try {
    const { token } = await params
    const share = await requireCommentingShare(request, token)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }
    const email = parseEmail((body as { email?: unknown } | null)?.email)
    const issued = await issueMagicToken(share, email)
    if (issued) {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin
      const verifyUrl = new URL(`/s/${token}/auth/verify`, base)
      verifyUrl.searchParams.set("t", issued.rawToken)
      try {
        await sendShareSignInEmail(email, verifyUrl.toString())
      } catch (error) {
        // Don't leave an undelivered token behind to throttle the next attempt for 15 minutes.
        await getPrisma().portalVerificationToken.deleteMany({ where: { tokenHash: hashMagicToken(share.id, issued.rawToken) } })
        throw error
      }
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return jsonError(error)
  }
}
