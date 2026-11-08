import { NextRequest, NextResponse } from "next/server"
import { SHARE_COMMENTER_TTL_MS, resolveShareByToken, shareSessionCookieName, verifyShareSession } from "@/lib/artifact-share"
import { commenterCookieName, redeemMagicToken } from "@/lib/artifact-share-comments"

/**
 * Landing page of the emailed link. The viewer must already hold the password session: the
 * email proves who they are, the password is still what lets them in. If they don't, the
 * token is left unspent and they are sent to the unlock form.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const home = new URL(`/s/${token}`, request.nextUrl.origin)
  const share = await resolveShareByToken(token)
  if (!share || !share.commentsEnabled) return NextResponse.redirect(home, 303)
  if (!(await verifyShareSession(share, request.cookies.get(shareSessionCookieName(token))?.value))) {
    return NextResponse.redirect(home, 303)
  }
  const redeemed = await redeemMagicToken(share, request.nextUrl.searchParams.get("t") ?? "")
  const response = NextResponse.redirect(home, 303)
  if (redeemed) {
    response.cookies.set(commenterCookieName(token), redeemed.commenterToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: `/s/${token}`,
      maxAge: Math.floor(SHARE_COMMENTER_TTL_MS / 1000),
    })
  }
  return response
}
