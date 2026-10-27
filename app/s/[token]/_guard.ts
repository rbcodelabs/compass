import { NextRequest, NextResponse } from "next/server"
import { resolveShareByToken, shareSessionCookieName, verifyShareSession, type PublicShare } from "@/lib/artifact-share"
import { assertCommentingOpen, ShareCommentError } from "@/lib/artifact-share-comments"

/** State-changing requests must come from this origin. SameSite=Lax already blocks cross-site POSTs; this is the second lock. */
export function sameOriginOrNull(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin")
  if (!origin) return null
  // Browsers send the literal "null" from sandboxed/opaque contexts; that must be a 403, not a throw (500).
  let originHost: string | null = null
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = null
  }
  if (originHost !== request.headers.get("host")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return null
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof ShareCommentError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error("[artifact-share] unexpected error", error)
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 })
}

/**
 * Link resolves, password session is valid, and commenting is open. Anything else is a
 * ShareCommentError; an unknown link and a locked one both read as 404 so neither is an oracle.
 */
export async function requireCommentingShare(request: NextRequest, rawToken: string): Promise<PublicShare> {
  const share = await resolveShareByToken(rawToken)
  if (!share) throw new ShareCommentError(404, "Not found.")
  if (!(await verifyShareSession(share, request.cookies.get(shareSessionCookieName(rawToken))?.value))) {
    throw new ShareCommentError(404, "Not found.")
  }
  assertCommentingOpen(share)
  return share
}
